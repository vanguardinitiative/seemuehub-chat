import type { Server, Socket } from "socket.io";
import { Types } from "mongoose";
import {
  actorFor,
  dataOf,
  logEvent,
  logLegacyConnection,
  refuse,
  socketAuthMiddleware,
  verifiedActorFor,
  type SocketAuthMode,
  type SocketErrorCode,
} from "./auth";
import type { ReactionPush } from "@/services/chat-push";
import type { ConversationMember } from "@/utils/conversation-access";
import { isClientMessageType } from "@/utils/message-type";
import {
  REACTION_RATE,
  allowInWindow,
  applyReaction,
  isReaction,
  reactionOf,
  reactionTargetProblem,
  reactionViews,
  type Reaction,
  type ReactionTarget,
  type StoredReaction,
} from "@/utils/reactions";
import { idString } from "@/utils/ids";
import { checkSticker } from "@/utils/sticker";

/**
 * The client-facing socket events. Everything that touches Redis or Mongo
 * comes in through `SocketDeps`, which config/socket.ts wires to the real
 * thing and the tests replace.
 */

/** A NEW_MESSAGE / NEW_GROUP_MESSAGE payload as the message controllers take it. */
export interface MessagePayload {
  _id?: string;
  messageType: string;
  content: string;
  conversationId?: string;
  senderId: string;
  receiverId: string;
  [field: string]: unknown;
}

/** What the SETUP handler publishes on Redis `SETUP` (see socket/rooms.ts). */
export interface SetupMessage {
  userId: string;
  socketId: string;
  conversationId?: string;
  partners: string[];
}

/** What REACT_MESSAGE publishes on Redis `REACTION` (see socket/rooms.ts deliverReaction). */
export interface ReactionMessage {
  userIds: string[];
  conversationId: string;
  messageId: string;
  reactions: ReturnType<typeof reactionViews>;
}

export interface SocketDeps {
  mode: SocketAuthMode;
  publish: (channel: string, message: string) => unknown;
  isParticipant: (conversationId: string, userId: string) => Promise<boolean>;
  conversationPartners: (userId: string) => Promise<string[]>;
  /** The conversation's participants when `userId` is one of them, else null (utils/conversation-access.ts). */
  membersOf: (conversationId: string, userId: string) => Promise<ConversationMember[] | null>;
  sendPrivateMessage: (socket: Socket, io: Server, data: MessagePayload) => Promise<void>;
  sendGroupMessage: (socket: Socket, io: Server, data: MessagePayload) => Promise<void>;
  /** The message a REACT_MESSAGE names (services/reactions.ts). */
  findReactionTarget: (messageId: string) => Promise<ReactionTarget | null>;
  /** The one reaction write; resolves to the list it replaced, or null when the message no longer takes reactions. */
  writeReaction: (
    messageId: string,
    userId: string,
    emoji: Reaction | null,
    at: Date
  ) => Promise<{ reactions?: StoredReaction[] | null } | null>;
  /** Tells a message's author about a new reaction through the backend; fire and forget (services/chat-push.ts). */
  pushReaction: (push: ReactionPush) => unknown;
  /** STICKER_URL_PREFIX: where a STICKER's image must live (utils/sticker.ts). */
  stickerUrlPrefix: string;
  /** The clock for the throttles; Date.now unless a test passes one. */
  now?: () => number;
}

/**
 * Message fields no client may set. The controllers spread the payload into
 * the stored message, so without this a sender could post "as" an
 * organization (sendAsOrganizationId, which REST only allows to its members),
 * as another actor, as a system order message, or with a made-up quote or
 * reactions.
 */
const RESERVED_MESSAGE_FIELDS = [
  "sender",
  "actorUserId",
  "sendAsOrganizationId",
  "isOrderMessage",
  "orderId",
  "orderStatus",
  "orderAction",
  "isDeleted",
  "deletedAt",
  "deletedBy",
  "deliveredAllAt",
  "readAllAt",
  // The service builds a reply's preview from the stored target
  // (utils/reply.ts), and only REACT_MESSAGE writes reactions.
  "replyPreview",
  "reactions",
] as const;

const isObjectId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value) && Types.ObjectId.isValid(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const withoutReservedFields = (data: Record<string, unknown>): MessagePayload => {
  const copy: Record<string, unknown> = { ...data };
  for (const field of RESERVED_MESSAGE_FIELDS) delete copy[field];
  return copy as MessagePayload;
};

export const registerSocketHandlers = (io: Server, deps: SocketDeps): void => {
  io.use(socketAuthMiddleware);

  io.on("connection", (socket) => {
    logLegacyConnection(socket, deps.mode);

    socket.on("SETUP", (data: unknown) => {
      handleSetup(socket, deps, data).catch((error) => {
        console.error("SETUP failed", { socketId: socket.id, error: error instanceof Error ? error.message : error });
      });
    });

    socket.on("NEW_MESSAGE", (data: unknown) => {
      handleMessage("NEW_MESSAGE", io, socket, deps, data).catch((error) => {
        console.error("NEW_MESSAGE failed", { socketId: socket.id, error: error instanceof Error ? error.message : error });
      });
    });

    socket.on("NEW_GROUP_MESSAGE", (data: unknown) => {
      handleMessage("NEW_GROUP_MESSAGE", io, socket, deps, data).catch((error) => {
        console.error("NEW_GROUP_MESSAGE failed", {
          socketId: socket.id,
          error: error instanceof Error ? error.message : error,
        });
      });
    });

    socket.on("REACT_MESSAGE", (data: unknown) => {
      handleReaction(socket, deps, data).catch((error) => {
        console.error("REACT_MESSAGE failed", { socketId: socket.id, error: error instanceof Error ? error.message : error });
      });
    });

    socket.on("disconnect", () => {
      const { roomUserId, partners } = dataOf(socket);
      // Only SETUP records a socketId on the user, so a socket that never
      // set up has nothing to mark offline.
      if (!roomUserId) return;
      deps.publish("USER_OFFLINE", JSON.stringify({ socketId: socket.id, userId: roomUserId, partners: partners ?? [] }));
    });
  });
};

/**
 * SETUP puts the socket in its user's room, which is where that user's
 * messages, order updates and payments are delivered. A verified socket joins
 * the room of its token's user whatever the payload says; the payload's
 * `conversationId` room (NEW_MESSAGE_PAGE) is joined only by a participant.
 */
const handleSetup = async (socket: Socket, deps: SocketDeps, raw: unknown): Promise<void> => {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const claimedUserId = asString(data.userId);
  const actor = actorFor(socket, "SETUP", deps.mode, claimedUserId);
  if (!actor) return;

  let userId: string;
  if (actor.kind === "verified") {
    userId = actor.userId;
    if (claimedUserId && claimedUserId !== userId) {
      logEvent({ msg: "setup_user_mismatch", socketId: socket.id, userId, claimedUserId });
    }
  } else {
    // A signed-out page (donate) sends SETUP with no userId: there is no room
    // for it to join.
    if (!isObjectId(claimedUserId)) return;
    userId = claimedUserId;
  }

  let conversationId: string | undefined;
  const requested = asString(data.conversationId);
  if (requested) {
    if (actor.kind === "legacy") {
      conversationId = requested;
    } else if (isObjectId(requested) && (await deps.isParticipant(requested, userId))) {
      conversationId = requested;
    } else {
      refuse(socket, "SETUP", "NOT_PARTICIPANT", { conversationId: requested });
    }
  }

  let partners: string[] = [];
  try {
    partners = await deps.conversationPartners(userId);
  } catch (error) {
    // Presence is a nicety; the user's own room still matters.
    console.error("conversation partners lookup failed", { userId, error: error instanceof Error ? error.message : error });
  }

  const socketData = dataOf(socket);
  socketData.roomUserId = userId;
  socketData.partners = partners;

  const message: SetupMessage = { userId, socketId: socket.id, partners };
  if (conversationId) message.conversationId = conversationId;
  await deps.publish("SETUP", JSON.stringify(message));
};

const handleMessage = async (
  event: "NEW_MESSAGE" | "NEW_GROUP_MESSAGE",
  io: Server,
  socket: Socket,
  deps: SocketDeps,
  raw: unknown
): Promise<void> => {
  const claimedSenderId = raw && typeof raw === "object" ? (raw as Record<string, unknown>).senderId : undefined;
  const actor = actorFor(socket, event, deps.mode, claimedSenderId);
  if (!actor) return;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    refuse(socket, event, "INVALID_PAYLOAD");
    return;
  }

  // SYSTEM and ORDER_* are the service's own messages (see
  // utils/message-type.ts). Checked for legacy sockets too: the type is
  // stored as sent, whoever sends it.
  const messageType = (raw as Record<string, unknown>).messageType;
  if (!isClientMessageType(messageType)) {
    const _id = (raw as Record<string, unknown>)._id ?? null;
    logEvent({
      msg: "message_refused",
      event,
      code: "INVALID_PAYLOAD",
      field: "messageType",
      messageType: typeof messageType === "string" ? messageType.slice(0, 40) : null,
      socketId: socket.id,
      userId: actor.kind === "verified" ? actor.userId : null,
    });
    refuse(socket, event, "INVALID_PAYLOAD", { field: "messageType", _id });
    return;
  }

  const message = withoutReservedFields(raw as Record<string, unknown>);

  // A STICKER is drawn as a bare image, so it may only point at one of ours
  // (see utils/sticker.ts). Legacy sockets too, like the type check above.
  if (messageType === "STICKER") {
    const sticker = checkSticker(message.attachments, deps.stickerUrlPrefix);
    if (!sticker.ok) {
      logEvent({
        msg: "message_refused",
        event,
        code: "INVALID_PAYLOAD",
        field: "attachments",
        reason: sticker.reason,
        socketId: socket.id,
        userId: actor.kind === "verified" ? actor.userId : null,
      });
      refuse(socket, event, "INVALID_PAYLOAD", { field: "attachments", _id: message._id ?? null });
      return;
    }
    message.content = sticker.content;
    message.attachments = sticker.attachments;
  }

  const send = event === "NEW_MESSAGE" ? deps.sendPrivateMessage : deps.sendGroupMessage;

  // Legacy (permissive only): the payload's senderId is trusted, as it
  // always was. This path goes away with SOCKET_AUTH_MODE=enforce.
  if (actor.kind === "legacy") {
    await send(socket, io, message);
    return;
  }

  if (message.senderId !== undefined && message.senderId !== actor.userId) {
    logEvent({ msg: "sender_override", event, socketId: socket.id, userId: actor.userId, claimedSenderId: String(message.senderId) });
  }
  message.senderId = actor.userId;

  // A private message without a conversationId goes through
  // createOrGetConversation(sender, receiver), which only ever yields a
  // conversation the sender is in. Anything addressed to an existing
  // conversation - every group message - needs the sender in it already.
  const conversationId = message.conversationId;
  if (event === "NEW_GROUP_MESSAGE" || (conversationId !== undefined && conversationId !== null && conversationId !== "")) {
    if (!isObjectId(conversationId) || !(await deps.isParticipant(conversationId, actor.userId))) {
      logEvent({ msg: "message_refused", event, code: "NOT_PARTICIPANT", socketId: socket.id, userId: actor.userId, conversationId: conversationId ?? null });
      refuse(socket, event, "NOT_PARTICIPANT", { conversationId: conversationId ?? null, _id: message._id ?? null });
      return;
    }
  }

  await send(socket, io, message);
};

/** The socket's REACT_MESSAGE timestamps for the rate limit (allowInWindow). */
const reactionTimesOf = (socket: Socket): number[] => {
  const data = dataOf(socket);
  if (!Array.isArray(data.reactionTimes)) data.reactionTimes = [];
  return data.reactionTimes;
};

/**
 * REACT_MESSAGE { messageId, emoji | null } (CHAT-CONTRACT.md §3.3): sets the
 * caller's reaction on a message (null removes it), then publishes REACTION
 * with the message's whole list to every participant.
 *
 * Refusals are `ERROR { code, event: "REACT_MESSAGE", messageId }`, and are
 * logged as `reaction_refused` with a reason:
 * - RATE_LIMITED: more than 10 in 10 s from this socket (counted first, so a
 *   flood never reaches Mongo);
 * - INVALID_PAYLOAD (`field` messageId or emoji): not an ObjectId, or an
 *   emoji that is not null nor one of the six; or (`field: "messageId"`) a
 *   deleted message, an order message, or a SYSTEM / ORDER_* one;
 * - NOT_PARTICIPANT: the caller is not in the message's conversation. A
 *   message id that does not exist gets the same answer, so a stranger
 *   learns nothing about which ids exist or are deleted.
 */
const handleReaction = async (socket: Socket, deps: SocketDeps, raw: unknown): Promise<void> => {
  const event = "REACT_MESSAGE";
  const actor = verifiedActorFor(socket, event, deps.mode, deps.now);
  if (!actor) return;

  const data = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const messageId = data.messageId;
  const echo = typeof messageId === "string" ? messageId.slice(0, 64) : null;
  const refuseReaction = (code: SocketErrorCode, reason: string, extra: Record<string, unknown> = {}): void => {
    logEvent({ msg: "reaction_refused", code, reason, socketId: socket.id, userId: actor.userId, messageId: echo });
    refuse(socket, event, code, { messageId: echo, ...extra });
  };

  const now = deps.now ?? Date.now;
  if (!allowInWindow(reactionTimesOf(socket), now(), REACTION_RATE.limit, REACTION_RATE.windowMs)) {
    refuseReaction("RATE_LIMITED", "RATE_LIMITED");
    return;
  }

  if (!isObjectId(messageId)) {
    refuseReaction("INVALID_PAYLOAD", "MESSAGE_ID", { field: "messageId" });
    return;
  }
  const emoji = data.emoji;
  if (emoji !== null && !isReaction(emoji)) {
    refuseReaction("INVALID_PAYLOAD", "EMOJI", { field: "emoji" });
    return;
  }

  const target = await deps.findReactionTarget(messageId);
  const conversationId = idString(target?.conversation);
  if (!target || !conversationId) {
    refuseReaction("NOT_PARTICIPANT", "NOT_FOUND");
    return;
  }
  const members = await deps.membersOf(conversationId, actor.userId);
  if (!members) {
    refuseReaction("NOT_PARTICIPANT", "NOT_PARTICIPANT");
    return;
  }
  const problem = reactionTargetProblem(target);
  if (problem) {
    refuseReaction("INVALID_PAYLOAD", problem, { field: "messageId" });
    return;
  }

  const at = new Date(now());
  const before = await deps.writeReaction(messageId, actor.userId, emoji, at);
  if (!before) {
    // Deleted between the check and the write.
    refuseReaction("INVALID_PAYLOAD", "DELETED", { field: "messageId" });
    return;
  }

  const notice: ReactionMessage = {
    userIds: members.map((member) => member.userId),
    conversationId,
    messageId,
    reactions: reactionViews(applyReaction(before.reactions, actor.userId, emoji, at)),
  };
  await deps.publish("REACTION", JSON.stringify(notice));

  // The author hears about a reaction that is new, added or changed to
  // another emoji, from someone else. Not a removal, and not the same emoji
  // again (CHAT-CONTRACT.md §3.5). reactionPushBody also leaves out an author
  // who left or muted the conversation.
  const previous = reactionOf(before.reactions, actor.userId);
  if (emoji !== null && emoji !== previous && idString(target.sender) !== actor.userId) {
    try {
      void Promise.resolve(
        deps.pushReaction({ conversationId, authorId: target.sender, reactorId: actor.userId, emoji, members })
      ).catch(() => {});
    } catch (error) {
      console.error("reaction push failed", { socketId: socket.id, error: error instanceof Error ? error.message : error });
    }
  }
};
