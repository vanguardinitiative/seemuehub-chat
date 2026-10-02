import { covers, participantIdOf, type ReadStateConversation, type ReadStateParticipant } from "./read-state";

/**
 * The delivered state (worktrees/CHAT-CONTRACT.md §5.1), as pure functions
 * over a conversation the way Mongo hands it back (lean or hydrated, users as
 * ObjectIds, strings or populated documents).
 *
 * A participant has received everything sent at or before their
 * `participants[].lastDeliveredAt`. It moves forward only ($max), from four
 * places: the socket's DELIVERED, GET /conversations, GET /messages and the
 * read PUT. When a write moves the recipient's mark past the latest message
 * from someone else, the other participants (its senders) hear DELIVERED.
 */

export interface DeliveredParticipant extends ReadStateParticipant {
  lastDeliveredAt?: Date | string | null;
}

export interface DeliveredConversation extends ReadStateConversation {
  _id?: unknown;
  participants?: DeliveredParticipant[] | null;
}

/** DELIVERED from one socket for one conversation is written at most this often; the latest upTo waits. */
export const DELIVERED_INTERVAL_MS = 2_000;

/** What a DELIVERED notice says (Redis `DELIVERED`, then CONVERSATION_LISTENING). */
export interface DeliveredNotice {
  /** The other participants: the senders. Never the recipient. */
  userIds: string[];
  conversationId: string;
  /** The recipient whose devices received it. */
  userId: string;
  deliveredAt: string;
}

const mineOf = (conversation: DeliveredConversation | null | undefined, userId: string): DeliveredParticipant | undefined =>
  (conversation?.participants ?? []).find((participant) => participantIdOf(participant) === userId);

/**
 * Whether `userId` has a delivery to record: they are a participant, the
 * latest message is from someone else, and their `lastDeliveredAt` (missing
 * counts as earlier) is before its `sendAt`.
 */
export const needsDelivery = (conversation: DeliveredConversation | null | undefined, userId: string): boolean => {
  const latest = conversation?.latestMessageData;
  const senderId = latest?.senderId == null ? null : String(latest.senderId);
  if (!senderId || senderId === userId) return false;
  const mine = mineOf(conversation, userId);
  return Boolean(mine) && !covers(mine?.lastDeliveredAt, latest?.sendAt);
};

/**
 * Whether writing `at` as `userId`'s delivered mark on `before` (the
 * conversation as it was before the write) moves it past the latest message
 * from someone else: the condition for a DELIVERED notice.
 */
export const deliveryMoves = (before: DeliveredConversation | null | undefined, userId: string, at: Date): boolean =>
  needsDelivery(before, userId) && covers(at, before?.latestMessageData?.sendAt);

/** Everyone in the conversation but `userId`: who a DELIVERED notice goes to. */
export const otherParticipants = (conversation: DeliveredConversation | null | undefined, userId: string): string[] => [
  ...new Set(
    (conversation?.participants ?? [])
      .map((participant) => participantIdOf(participant))
      .filter((id): id is string => id !== null && id !== userId)
  ),
];

/**
 * Sets `userId`'s `lastDeliveredAt` on `conversation` to what the $max left
 * (the later of the two), in place, so a response shows the write it just
 * made. Returns the conversation.
 */
export const withDelivered = <T extends DeliveredConversation>(conversation: T, userId: string, at: Date): T => {
  const mine = mineOf(conversation, userId);
  if (mine && !covers(mine.lastDeliveredAt, at)) mine.lastDeliveredAt = at;
  return conversation;
};

/** A client's `upTo`: a valid date no later than now, else now. */
export const clampUpTo = (upTo: unknown, now: Date): Date => {
  if (typeof upTo !== "string" && typeof upTo !== "number") return now;
  const date = new Date(upTo);
  if (Number.isNaN(date.getTime()) || date.getTime() > now.getTime()) return now;
  return date;
};
