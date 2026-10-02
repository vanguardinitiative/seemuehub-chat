import type { Server } from "socket.io";
import { dataOf, logEvent, type SocketAuthMode } from "./auth";

/**
 * Who hears what, for the Redis subscribers in config/redis.ts. Kept free of
 * Redis and Mongo so the tests can drive it with a bare socket.io server.
 *
 * Rooms: every socket that completed SETUP is in its user's room (the userId),
 * and optionally in one conversation room (the conversationId) it proved it
 * belongs to.
 */

/**
 * The instance that holds the socket joins it to the rooms a SETUP message
 * names. The message was built from the verified user by the SETUP handler;
 * the check against `socket.data.userId` makes sure a message that did not
 * come from there cannot put an authenticated socket in someone else's room.
 * "absent" means the socket is on another instance (or already gone).
 */
export const joinSetupRooms = (
  io: Server,
  message: { userId: string; socketId: string; conversationId?: string }
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
  return "joined";
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
