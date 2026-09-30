import type { Server, Socket } from "socket.io";
import { Types } from "mongoose";
import { actorFor, dataOf, logEvent, logLegacyConnection, refuse, socketAuthMiddleware, type SocketAuthMode } from "./auth";
import { isClientMessageType } from "@/utils/message-type";

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

export interface SocketDeps {
  mode: SocketAuthMode;
  publish: (channel: string, message: string) => unknown;
  isParticipant: (conversationId: string, userId: string) => Promise<boolean>;
  conversationPartners: (userId: string) => Promise<string[]>;
  sendPrivateMessage: (socket: Socket, io: Server, data: MessagePayload) => Promise<void>;
  sendGroupMessage: (socket: Socket, io: Server, data: MessagePayload) => Promise<void>;
}

/**
 * Message fields no client may set. The controllers spread the payload into
 * the stored message, so without this a sender could post "as" an
 * organization (sendAsOrganizationId, which REST only allows to its members),
 * as another actor, or as a system order message.
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
