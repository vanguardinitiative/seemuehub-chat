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
import { DELIVERED_INTERVAL_MS, clampUpTo, deliveryMoves, otherParticipants, type DeliveredConversation, type DeliveredNotice } from "@/utils/delivered";
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
import { makeRoomForTyping, membershipExpired, newTypingEntry, stillTyping, typingPasses, type TypingEntry } from "./typing";

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
  /** The `org:{orgId}` rooms of the organizations whose chats this member may LIST (verified sockets only). */
  orgRooms?: string[];
}

/**
 * Who hears a socket's TYPING in a conversation (utils/conversation-access.ts
 * audienceOf): a participant hears as before, plus the company's room when
 * the conversation is a company's; a member typing for the company (in its
 * org room, not a participant) is heard by the participants.
 */
export interface ConversationAudience {
  participant: boolean;
  /** The participants other than the caller. */
  others: string[];
  /** A company conversation's org room, for a participant (the candidate) typing. */
  orgRoom: string | null;
}

/** What REACT_MESSAGE publishes on Redis `REACTION` (see socket/rooms.ts deliverReaction). */
export interface ReactionMessage {
  userIds: string[];
  conversationId: string;
  messageId: string;
  reactions: ReturnType<typeof reactionViews>;
}

/** What TYPING publishes on Redis `TYPING` (see socket/rooms.ts deliverTyping). */
export interface TypingMessage {
  /** The other participants; never the typer. */
  userIds: string[];
  conversationId: string;
  userId: string;
  typing: boolean;
  /** The candidate typing in a company conversation: its org room. */
  orgRoom?: string;
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
  /**
   * DELIVERED's write: `at` as the caller's lastDeliveredAt ($max), resolving
   * to the conversation as it was before, or null for a non-participant
   * (services/delivered.ts).
   */
  writeDelivered: (conversationId: string, userId: string, at: Date) => Promise<DeliveredConversation | null>;
  /** STICKER_URL_PREFIX: where a STICKER's image must live (utils/sticker.ts). */
  stickerUrlPrefix: string;
  /**
   * The org rooms a verified user's socket joins at SETUP (services/org-chat.ts
   * orgRoomsFor). Absent, or empty with ORG_CHAT_ENABLED off: none.
   */
  orgRoomsFor?: (userId: string) => Promise<string[]>;
  /**
   * TYPING's audience, company conversations included (utils/conversation-access.ts).
   * Absent: membersOf, participants only, as before company chat.
   */
  audienceOf?: (conversationId: string, userId: string, orgRooms: readonly string[]) => Promise<ConversationAudience | null>;
  /** The clock for the throttles; Date.now unless a test passes one. */
  now?: () => number;
  /** Timers for DELIVERED's deferred write; setTimeout / clearTimeout unless a test passes its own. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
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

    socket.on("TYPING", (data: unknown) => {
      handleTyping(socket, deps, data).catch((error) => {
        console.error("TYPING failed", { socketId: socket.id, error: error instanceof Error ? error.message : error });
      });
    });

    socket.on("DELIVERED", (data: unknown) => {
      handleDelivered(socket, deps, data).catch((error) => {
        console.error("DELIVERED failed", { socketId: socket.id, error: error instanceof Error ? error.message : error });
      });
    });

    socket.on("disconnect", () => {
      stopTyping(socket, deps);
      flushDeliveredOnDisconnect(socket, deps);
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

  // A member of a company hears its conversations in its org room
  // (ORG-CHAT-CONTRACT.md §3.4). Verified sockets only: a legacy socket's
  // userId is whatever it claims.
  let orgRooms: string[] = [];
  if (actor.kind === "verified" && deps.orgRoomsFor) {
    try {
      orgRooms = await deps.orgRoomsFor(userId);
    } catch (error) {
      console.error("org rooms lookup failed", { userId, error: error instanceof Error ? error.message : error });
    }
  }

  const socketData = dataOf(socket);
  socketData.roomUserId = userId;
  socketData.partners = partners;
  socketData.orgRooms = orgRooms;

  const message: SetupMessage = { userId, socketId: socket.id, partners };
  if (conversationId) message.conversationId = conversationId;
  if (orgRooms.length > 0) message.orgRooms = orgRooms;
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

const typingEntriesOf = (socket: Socket): Map<string, TypingEntry> => {
  const data = dataOf(socket);
  if (!(data.typing instanceof Map)) data.typing = new Map();
  return data.typing;
};

/**
 * The socket's cached membership of a conversation, with the other
 * participants (socket/typing.ts): looked up at most every 10 minutes (a
 * refusal every minute), shared by TYPING and DELIVERED. Events that arrive
 * during a lookup wait for that one lookup, then go on in the order they
 * came. Null when the lookup failed: the event is dropped, quietly, and the
 * next one tries again.
 */
const memberEntry = async (
  socket: Socket,
  deps: SocketDeps,
  event: string,
  conversationId: string,
  userId: string
): Promise<TypingEntry | null> => {
  const now = deps.now ?? Date.now;
  const entries = typingEntriesOf(socket);
  let entry = entries.get(conversationId);
  if (!entry) {
    makeRoomForTyping(entries);
    entry = newTypingEntry();
    entries.set(conversationId, entry);
  }

  if (!entry.pending && membershipExpired(entry, now())) {
    const checking = entry;
    const lookup: Promise<ConversationAudience | null> = deps.audienceOf
      ? deps.audienceOf(conversationId, userId, dataOf(socket).orgRooms ?? [])
      : deps.membersOf(conversationId, userId).then((members) =>
          members === null
            ? null
            : { participant: true, others: members.map((member) => member.userId).filter((id) => id !== userId), orgRoom: null }
        );
    checking.pending = lookup
      .then(
        (audience) => {
          checking.member = audience?.participant === true;
          checking.orgSide = audience !== null && audience !== undefined && !audience.participant;
          checking.others = (audience?.others ?? []).filter((id) => id !== userId);
          checking.orgRoom = audience?.participant ? audience.orgRoom : null;
          checking.checkedAt = now();
          return true;
        },
        (error) => {
          console.error("membership lookup failed", {
            event,
            socketId: socket.id,
            conversationId,
            error: error instanceof Error ? error.message : error,
          });
          return false;
        }
      )
      .finally(() => {
        checking.pending = undefined;
      });
  }
  if (entry.pending && !(await entry.pending)) return null;
  return entry;
};

/**
 * TYPING { conversationId, typing } (CHAT-CONTRACT.md §4.1): relayed to the
 * conversation's other participants, nothing written anywhere.
 *
 * - An authenticated socket only (AUTH_REQUIRED otherwise, as REACT_MESSAGE).
 * - `conversationId` an ObjectId and `typing` a boolean: else ERROR
 *   INVALID_PAYLOAD.
 * - Membership is looked up once and cached on the socket for 10 minutes,
 *   with the other participants (socket/typing.ts). Not a participant: ERROR
 *   NOT_PARTICIPANT (that answer is kept for a minute).
 * - At most one forwarded per second per conversation; the rest are dropped
 *   silently, except a `typing: false` after a forwarded `true`.
 */
const handleTyping = async (socket: Socket, deps: SocketDeps, raw: unknown): Promise<void> => {
  const event = "TYPING";
  const actor = verifiedActorFor(socket, event, deps.mode, deps.now);
  if (!actor) return;

  const data = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const conversationId = data.conversationId;
  const typing = data.typing;
  if (!isObjectId(conversationId) || typeof typing !== "boolean") {
    refuse(socket, event, "INVALID_PAYLOAD", {
      conversationId: typeof conversationId === "string" ? conversationId.slice(0, 64) : null,
    });
    return;
  }

  const now = deps.now ?? Date.now;
  const entry = await memberEntry(socket, deps, event, conversationId, actor.userId);
  if (!entry) return;
  // A participant, or a member typing for the company in its conversation.
  if (!entry.member && !entry.orgSide) {
    refuse(socket, event, "NOT_PARTICIPANT", { conversationId });
    return;
  }

  // Gone while the lookup ran: its disconnect has already said "stopped".
  if (!socket.connected) return;

  const at = now();
  if (!typingPasses(entry, typing, at)) return;
  entry.lastForwardedAt = at;
  entry.typing = typing;
  if (entry.others.length === 0 && !entry.orgRoom) return;

  const message: TypingMessage = { userIds: [...entry.others], conversationId, userId: actor.userId, typing };
  if (entry.orgRoom) message.orgRoom = entry.orgRoom;
  await deps.publish("TYPING", JSON.stringify(message));
};

/**
 * On disconnect: `typing: false` for every conversation this socket last
 * reported `typing: true` in, so nobody is left watching dots.
 */
const stopTyping = (socket: Socket, deps: SocketDeps): void => {
  const data = dataOf(socket);
  const userId = data.userId;
  const typing = stillTyping(data.typing);
  data.typing?.clear();
  if (!userId) return;
  for (const { conversationId, others, orgRoom } of typing) {
    const message: TypingMessage = { userIds: others, conversationId, userId, typing: false };
    if (orgRoom) message.orgRoom = orgRoom;
    try {
      void Promise.resolve(deps.publish("TYPING", JSON.stringify(message))).catch(() => {});
    } catch (error) {
      console.error("TYPING stop failed", { socketId: socket.id, error: error instanceof Error ? error.message : error });
    }
  }
};

/** One socket's DELIVERED state for one conversation: when it last wrote, and the upTo waiting for the next write. */
interface DeliveredState {
  lastWriteAt: number | null;
  pendingUpTo?: Date;
  timer?: unknown;
  userId: string;
}

/** DELIVERED states a socket keeps before idle ones are forgotten. */
const MAX_DELIVERED_STATES = 100;

const deliveredStatesOf = (socket: Socket): Map<string, DeliveredState> => {
  const data = dataOf(socket);
  if (!(data.delivered instanceof Map)) data.delivered = new Map();
  return data.delivered;
};

const later = (a: Date | undefined, b: Date): Date => (a && a.getTime() > b.getTime() ? a : b);

/**
 * DELIVERED { conversationId, upTo? } (CHAT-CONTRACT.md §5.1): a new client
 * sends it when a NEW_MESSAGE from someone else reaches its socket. The
 * caller's `participants[].lastDeliveredAt` moves to `upTo` (a valid date no
 * later than now; anything else is now), never back.
 *
 * - An authenticated socket only (AUTH_REQUIRED otherwise).
 * - `conversationId` an ObjectId, else ERROR INVALID_PAYLOAD.
 * - Membership from the socket's cache, shared with TYPING; not a
 *   participant: ERROR NOT_PARTICIPANT.
 * - At most one write per 2 s per conversation per socket. One that comes
 *   sooner is not lost: the latest upTo waits and is written when the 2 s are
 *   up (or when the socket disconnects).
 *
 * When the write moves the mark past the latest message from someone else,
 * DELIVERED goes to the other participants (deliverDelivered).
 */
const handleDelivered = async (socket: Socket, deps: SocketDeps, raw: unknown): Promise<void> => {
  const event = "DELIVERED";
  const actor = verifiedActorFor(socket, event, deps.mode, deps.now);
  if (!actor) return;

  const data = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const conversationId = data.conversationId;
  if (!isObjectId(conversationId)) {
    refuse(socket, event, "INVALID_PAYLOAD", {
      conversationId: typeof conversationId === "string" ? conversationId.slice(0, 64) : null,
    });
    return;
  }
  const now = deps.now ?? Date.now;
  const upTo = clampUpTo(data.upTo, new Date(now()));

  const entry = await memberEntry(socket, deps, event, conversationId, actor.userId);
  if (!entry) return;
  if (!entry.member) {
    refuse(socket, event, "NOT_PARTICIPANT", { conversationId });
    return;
  }

  const states = deliveredStatesOf(socket);
  let state = states.get(conversationId);
  if (!state) {
    if (states.size >= MAX_DELIVERED_STATES) {
      for (const [id, idle] of states) {
        if (states.size < MAX_DELIVERED_STATES) break;
        if (idle.timer === undefined) states.delete(id);
      }
    }
    state = { lastWriteAt: null, userId: actor.userId };
    states.set(conversationId, state);
  }

  // A write is already waiting: this upTo joins it.
  if (state.timer !== undefined) {
    state.pendingUpTo = later(state.pendingUpTo, upTo);
    return;
  }
  const wait = state.lastWriteAt === null ? 0 : state.lastWriteAt + DELIVERED_INTERVAL_MS - now();
  if (wait > 0) {
    const waiting = state;
    waiting.pendingUpTo = later(waiting.pendingUpTo, upTo);
    waiting.timer = (deps.setTimer ?? setTimeout)(() => {
      waiting.timer = undefined;
      flushDelivered(socket, deps, conversationId, waiting);
    }, wait);
    return;
  }
  await writeDeliveredMark(socket, deps, conversationId, state, upTo);
};

const writeDeliveredMark = async (
  socket: Socket,
  deps: SocketDeps,
  conversationId: string,
  state: DeliveredState,
  upTo: Date
): Promise<void> => {
  state.lastWriteAt = (deps.now ?? Date.now)();
  const before = await deps.writeDelivered(conversationId, state.userId, upTo);
  if (!before || !deliveryMoves(before, state.userId, upTo)) return;
  const notice: DeliveredNotice = {
    userIds: otherParticipants(before, state.userId),
    conversationId,
    userId: state.userId,
    deliveredAt: upTo.toISOString(),
  };
  if (notice.userIds.length === 0) return;
  await deps.publish("DELIVERED", JSON.stringify(notice));
};

/** Writes the upTo that was waiting, if any; never throws. */
const flushDelivered = (socket: Socket, deps: SocketDeps, conversationId: string, state: DeliveredState): void => {
  const upTo = state.pendingUpTo;
  state.pendingUpTo = undefined;
  if (!upTo) return;
  writeDeliveredMark(socket, deps, conversationId, state, upTo).catch((error) => {
    console.error("DELIVERED write failed", { socketId: socket.id, conversationId, error: error instanceof Error ? error.message : error });
  });
};

/** On disconnect, a waiting upTo is written now rather than dropped: the messages did reach this device. */
const flushDeliveredOnDisconnect = (socket: Socket, deps: SocketDeps): void => {
  const states = dataOf(socket).delivered;
  if (!states) return;
  for (const [conversationId, state] of states) {
    if (state.timer === undefined) continue;
    (deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout)))(state.timer);
    state.timer = undefined;
    flushDelivered(socket, deps, conversationId, state);
  }
  states.clear();
};
