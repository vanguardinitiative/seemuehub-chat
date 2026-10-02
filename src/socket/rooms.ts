import type { Server } from "socket.io";
import { dataOf, logEvent, type SocketAuthMode } from "./auth";

/**
 * Who hears what, for the Redis subscribers in config/redis.ts. Kept free of
 * Redis and Mongo so the tests can drive it with a bare socket.io server.
 *
 * Rooms: every socket that completed SETUP is in its user's room (the userId),
 * and optionally in one conversation room (the conversationId) it proved it
 * belongs to. A member who may chat for an organization is also in that
 * organization's room, `org:{orgId}` (worktrees/ORG-CHAT-CONTRACT.md §3.4):
 * members are never participants of its conversations, so that room is how
 * a company inbox hears them.
 */

/** An organization's room. Its members' sockets join it at SETUP when they may LIST its conversations. */
export const orgRoomOf = (organizationId: unknown): string | null => {
  const id = organizationId === null || organizationId === undefined ? "" : String(organizationId);
  return /^[0-9a-fA-F]{24}$/.test(id) ? `org:${id.toLowerCase()}` : null;
};

const isOrgRoom = (room: unknown): room is string => typeof room === "string" && /^org:[0-9a-f]{24}$/.test(room);

/**
 * The instance that holds the socket joins it to the rooms a SETUP message
 * names. The message was built from the verified user by the SETUP handler;
 * the check against `socket.data.userId` makes sure a message that did not
 * come from there cannot put an authenticated socket in someone else's room.
 * "absent" means the socket is on another instance (or already gone).
 */
export const joinSetupRooms = (
  io: Server,
  message: { userId: string; socketId: string; conversationId?: string; orgRooms?: unknown }
): "joined" | "absent" | "refused" => {
  const socket = io.sockets.sockets.get(message.socketId);
  if (!socket) return "absent";
  const verified = dataOf(socket).userId;
  if (verified && verified !== message.userId) {
    logEvent({ msg: "setup_room_refused", socketId: message.socketId, userId: verified, roomUserId: message.userId });
    return "refused";
  }
  socket.join(message.userId);
  if (message.conversationId) socket.join(message.conversationId);
  // Only for a verified socket: the SETUP handler never names org rooms for
  // a legacy one, and a message that did would not get them either.
  if (verified && Array.isArray(message.orgRooms)) {
    for (const room of message.orgRooms) if (isOrgRoom(room)) socket.join(room);
  }
  return "joined";
};

/** What SEND_MESSAGE carries: the conversation after the write, and the stored message, both through JSON. */
export interface NewMessageConversation {
  _id: unknown;
  participants?: { user?: unknown }[];
  organizationId?: unknown;
}

/**
 * NEW_MESSAGE to every participant's room (after 4 s for a file, video or
 * voice message, which the client uploads after sending), NEW_MESSAGE_PAGE
 * to the conversation's own room, and, for an organization's conversation,
 * NEW_MESSAGE to its `org:{orgId}` room with the same delay.
 */
export const deliverNewMessage = (
  io: Server,
  conversation: NewMessageConversation,
  messageData: { messageType?: unknown },
  setTimer: (fn: () => void, ms: number) => unknown = setTimeout
): void => {
  const dataResponse = { type: "NEW_MESSAGE", response: { ...messageData } };
  const dataResponseOrder = { type: "NEW_MESSAGE_PAGE", response: { ...messageData } };
  const delay: number = ["FILE", "VIDEO", "VOICE"].includes(String(messageData.messageType ?? "")) ? 4000 : 0;

  const rooms = (conversation.participants ?? [])
    .map((participant) => (participant?.user === undefined || participant?.user === null ? "" : String(participant.user)))
    .filter((room) => room.length > 0);
  const orgRoom = orgRoomOf(conversation.organizationId);
  if (orgRoom) rooms.push(orgRoom);
  for (const room of rooms) {
    setTimer(() => {
      io.to(room).emit("CONVERSATION_LISTENING", dataResponse);
    }, delay);
  }
  // If the conversation is of type ORDER, emit to the conversation room as well
  io.to(String(conversation._id)).emit("CONVERSATION_LISTENING", dataResponseOrder);
};

/**
 * Online/offline goes to the people who share a conversation with the user
 * (looked up once, at SETUP) instead of to every connected socket.
 *
 * Never call `io.to([])`: socket.io treats an empty room list as "everyone".
 */
export const emitPresence = (
  io: Server,
  partners: unknown,
  response: { userId: unknown; isOnline: boolean }
): void => {
  const rooms = Array.isArray(partners)
    ? partners.filter((room): room is string => typeof room === "string" && room.length > 0)
    : [];
  if (rooms.length === 0) return;
  io.to(rooms).emit("CONVERSATION_LISTENING", { type: "USER_ONLINE", response });
};

/** What PUT /message-status/read publishes on Redis `READ_MESSAGE` (CHAT-CONTRACT.md §1.2). */
export interface ReadMessageNotice {
  userIds?: unknown;
  conversationId?: unknown;
  readerId?: unknown;
  readAt?: unknown;
  readAllAt?: unknown;
  /** A candidate's read of an organization conversation also goes to the company (ORG-CHAT-CONTRACT.md §3.4). */
  orgRoom?: unknown;
}

/**
 * READ_MESSAGE goes to the rooms the publisher chose: the reader, and the
 * latest sender when the read made the message read by all. `response` stays
 * the conversationId string for old clients, which take any READ_MESSAGE as
 * "this chat is read for me"; new clients tell their own devices from the
 * other side by `readerId` (CHAT-CONTRACT.md §1.3). A notice without a
 * `readerId` (published by an older instance) goes out in the old shape.
 */
export const deliverReadMessage = (io: Server, notice: ReadMessageNotice): void => {
  const rooms = Array.isArray(notice?.userIds)
    ? [...new Set(notice.userIds.filter((room): room is string => typeof room === "string" && room.length > 0))]
    : [];
  if (isOrgRoom(notice?.orgRoom)) rooms.push(notice.orgRoom);
  // Never io.to([]): socket.io treats an empty room list as "everyone".
  if (rooms.length === 0) return;
  const payload: Record<string, unknown> = { type: "READ_MESSAGE", response: notice.conversationId };
  if (notice.readerId !== undefined && notice.readerId !== null) {
    payload.readerId = notice.readerId;
    payload.readAt = notice.readAt ?? null;
    payload.readAllAt = notice.readAllAt ?? null;
  }
  io.to(rooms).emit("CONVERSATION_LISTENING", payload);
};

/** The user rooms a notice names: strings only, no repeats. */
const userRooms = (userIds: unknown): string[] =>
  Array.isArray(userIds)
    ? [...new Set(userIds.filter((room): room is string => typeof room === "string" && room.length > 0))]
    : [];

/** What REACT_MESSAGE publishes on Redis `REACTION` (CHAT-CONTRACT.md §3.4). */
export interface ReactionNotice {
  userIds?: unknown;
  conversationId?: unknown;
  messageId?: unknown;
  reactions?: unknown;
}

/**
 * REACTION goes to every participant's room, the reactor's included (their
 * other devices). `reactions` is the message's whole list as stored after
 * the write (`user` a string, `at` ISO); clients replace theirs with it.
 */
export const deliverReaction = (io: Server, notice: ReactionNotice): void => {
  const rooms = userRooms(notice?.userIds);
  // Never io.to([]): socket.io treats an empty room list as "everyone".
  if (rooms.length === 0) return;
  io.to(rooms).emit("CONVERSATION_LISTENING", {
    type: "REACTION",
    response: {
      conversationId: notice.conversationId,
      messageId: notice.messageId,
      reactions: Array.isArray(notice.reactions) ? notice.reactions : [],
    },
  });
};

/** What TYPING publishes on Redis `TYPING` (CHAT-CONTRACT.md §4.1). */
export interface TypingNotice {
  userIds?: unknown;
  conversationId?: unknown;
  userId?: unknown;
  typing?: unknown;
  /** The candidate typing in an organization conversation: the company hears it too. */
  orgRoom?: unknown;
}

/**
 * TYPING goes to the other participants' rooms only: the publisher already
 * left the typer out, and the typer's own room is dropped here again, so
 * their other devices never show their own dots. A candidate's TYPING in an
 * organization conversation also goes to its org room.
 */
export const deliverTyping = (io: Server, notice: TypingNotice): void => {
  const rooms = userRooms(notice?.userIds).filter((room) => room !== notice.userId);
  if (isOrgRoom(notice?.orgRoom)) rooms.push(notice.orgRoom);
  // Never io.to([]): socket.io treats an empty room list as "everyone".
  if (rooms.length === 0) return;
  io.to(rooms).emit("CONVERSATION_LISTENING", {
    type: "TYPING",
    response: { conversationId: notice.conversationId, userId: notice.userId, typing: notice.typing === true },
  });
};

/** What a delivery publishes on Redis `DELIVERED` (CHAT-CONTRACT.md §5.1). */
export interface DeliveredNotice {
  userIds?: unknown;
  conversationId?: unknown;
  userId?: unknown;
  deliveredAt?: unknown;
}

/**
 * DELIVERED goes to the other participants (the senders, who draw ✓✓), never
 * to the recipient's own room: the publisher left them out, and they are
 * dropped here again.
 */
export const deliverDelivered = (io: Server, notice: DeliveredNotice): void => {
  const rooms = userRooms(notice?.userIds).filter((room) => room !== notice.userId);
  // Never io.to([]): socket.io treats an empty room list as "everyone".
  if (rooms.length === 0) return;
  io.to(rooms).emit("CONVERSATION_LISTENING", {
    type: "DELIVERED",
    response: { conversationId: notice.conversationId, userId: notice.userId, deliveredAt: notice.deliveredAt ?? null },
  });
};

export interface PaymentEvent {
  type: "PAYMENT";
  response: unknown;
}

export type PaymentDelivery =
  | { to: string; payload: PaymentEvent }
  | { broadcast: true; except: string[]; payload: PaymentEvent };

/**
 * Where a PAYMENT from the backend (POST /core-socket/payment) goes. Every
 * payment has a payer room when it has a userId, and gets the backend's
 * payload (already trimmed by the backend's chatPaymentPayload).
 *
 * A donation can be anonymous: POST /donates takes optional auth and the
 * signed-out /donate page matches the result on `referenceId`, which is the
 * Donate document's ObjectId. That is not a secret - ObjectIds are a
 * timestamp and a counter, and the broadcast hands every one of them to every
 * socket anyway - so the broadcast (reduced to type, referenceId and status)
 * is kept only in permissive mode. In enforce mode a donation reaches its
 * donor's room, if it has one, and nobody else.
 */
export const routePayment = (data: any, mode: SocketAuthMode): PaymentDelivery[] => {
  const userId = data?.userId ? String(data.userId) : "";
  const deliveries: PaymentDelivery[] = [];
  if (userId) deliveries.push({ to: userId, payload: { type: "PAYMENT", response: data } });

  if (data?.type === "DONATE" && mode === "permissive") {
    deliveries.push({
      broadcast: true,
      // The donor already has the full event in its room.
      except: userId ? [userId] : [],
      payload: {
        type: "PAYMENT",
        response: { type: data.type, referenceId: data.referenceId, status: data.status },
      },
    });
  }
  return deliveries;
};

export const deliverPayment = (io: Server, deliveries: PaymentDelivery[]): void => {
  for (const delivery of deliveries) {
    if ("to" in delivery) {
      io.to(delivery.to).emit("LISTENING", delivery.payload);
    } else if (delivery.except.length > 0) {
      io.except(delivery.except).emit("LISTENING", delivery.payload);
    } else {
      io.emit("LISTENING", delivery.payload);
    }
  }
};
