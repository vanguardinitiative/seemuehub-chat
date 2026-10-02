/**
 * Read state (worktrees/CHAT-CONTRACT.md §1.2, §1.4), as pure functions over a
 * conversation the way Mongo hands it back: lean or hydrated, with each
 * `participants[].user` an ObjectId, a string, a populated user (`{ _id, … }`)
 * or null (a populated user that no longer exists).
 *
 * A participant has read everything sent at or before their `lastReadAt`.
 * The only writers of `lastReadAt` are PUT /message-status/read and
 * scripts/backfill-read-state.ts.
 */

export interface ReadStateParticipant {
  user?: unknown;
  lastReadAt?: Date | string | null;
}

export interface ReadStateConversation {
  conversationType?: string;
  participants?: ReadStateParticipant[] | null;
  latestMessageData?: {
    senderId?: unknown;
    sendAt?: Date | string | null;
  } | null;
}

/** An id as a 24-hex string, from a string, an ObjectId or anything with an `_id`; null when there is none. */
const idOf = (value: unknown, depth = 0): string | null => {
  if (value == null || depth > 2) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value !== "object") return null;
  // An ObjectId (any bson copy). Checked before `_id`: mongoose gives
  // ObjectId a `_id` getter that returns the ObjectId itself.
  const hex = (value as { toHexString?: unknown }).toHexString;
  if (typeof hex === "function") return String(hex.call(value));
  return idOf((value as { _id?: unknown })._id, depth + 1);
};

/** A participant's user id as a string, whatever shape `user` has; null when it has none. */
export const participantIdOf = (participant: ReadStateParticipant | null | undefined): string | null =>
  idOf(participant?.user);

const timeOf = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const time = value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
  return Number.isNaN(time) ? null : time;
};

/**
 * Whether a read mark covers a message sent at `sendAt`. A message with no
 * `sendAt` cannot be placed in time, so any read mark covers it: once someone
 * has read the conversation, a timeless latest message does not stay unread
 * for them forever.
 */
const covers = (lastReadAt: unknown, sendAt: unknown): boolean => {
  const read = timeOf(lastReadAt);
  if (read === null) return false;
  const sent = timeOf(sendAt);
  return sent === null || read >= sent;
};

/**
 * Whether `userId` has read the conversation's latest message: they sent it,
 * or their `lastReadAt` is at or after it, or the legacy MessageStatus row for
 * it says READ (`legacyRead`, group chats). A conversation without a latest
 * sender has nothing to read and counts as read.
 */
export const isReadFor = (
  conversation: ReadStateConversation | null | undefined,
  userId: string,
  legacyRead?: boolean
): boolean => {
  const latest = conversation?.latestMessageData;
  const senderId = idOf(latest?.senderId);
  if (!senderId) return true;
  if (senderId === userId) return true;
  if (legacyRead === true) return true;
  const mine = (conversation?.participants ?? []).find((participant) => participantIdOf(participant) === userId);
  return Boolean(mine && covers(mine.lastReadAt, latest?.sendAt));
};

/**
 * Whether everyone but the latest message's sender has read it, which is when
 * `latestMessageData.readAllAt` is set. Never for a GROUP (its receipts are
 * the legacy MessageStatus rows), and never vacuously: a conversation whose
 * only participant sent the latest message (an organization conversation,
 * where the organization's members are not participants) has nobody to read
 * it. Participants without a user id cannot read and are not counted. No
 * latest message, nothing to have read: false.
 */
export const allOthersRead = (conversation: ReadStateConversation | null | undefined): boolean => {
  if (!conversation || conversation.conversationType === "GROUP") return false;
  const latest = conversation.latestMessageData;
  const senderId = idOf(latest?.senderId);
  if (!senderId) return false;
  const others = (conversation.participants ?? []).filter((participant) => {
    const id = participantIdOf(participant);
    return id !== null && id !== senderId;
  });
  return others.length > 0 && others.every((participant) => covers(participant.lastReadAt, latest?.sendAt));
};
