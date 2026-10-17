import { Types } from "mongoose";
import { idString, isObjectIdString } from "@/utils/ids";

/**
 * User blocks in chat (worktrees/STORE-SAFETY-CONTRACT.md §2.2), the pure
 * rules: which conversations a block applies to, who the other person is,
 * and whether a pair is blocked. No Mongo, no Redis.
 *
 * A block applies to PRIVATE one-to-one conversations only. How one is told
 * apart from the rest:
 * - an ORDER conversation has `conversationType: "ORDER"` and an `orderId`
 *   (seemuehub-backend creates those);
 * - a company conversation is PRIVATE too, but has an `organizationId` and
 *   a single participant, the candidate (ORG-CHAT-CONTRACT.md §3.1); it
 *   keeps its own block, `candidateBlockedAt`;
 * - a GROUP or ANONYMOUS conversation has its own type.
 * So: type PRIVATE (or none, the schema's default), no `orderId`, no
 * `organizationId`, and exactly two distinct participants, the caller one of
 * them.
 *
 * A pair is blocked when a row exists in either direction. Neither side is
 * ever told which.
 */

/** The code every refusal carries, REST and socket. */
export const CHAT_USER_BLOCKED = "CHAT_USER_BLOCKED";

/**
 * What a refusal says. The same words for both sides, so the answer never
 * tells who blocked whom: "You cannot send messages to this person".
 */
export const CHAT_USER_BLOCKED_MESSAGE = "ທ່ານບໍ່ສາມາດສົ່ງຂໍ້ຄວາມຫາຄົນນີ້ໄດ້";

/** The fields of a conversation the rules read; ids in any shape Mongo or JSON hands them over. */
export interface BlockableConversation {
  conversationType?: unknown;
  orderId?: unknown;
  organizationId?: unknown;
  participants?: ({ user?: unknown } | null | undefined)[] | null;
}

/** A userblocks row as read: `blockerId` blocked `blockedId`. */
export interface BlockRow {
  blockerId?: unknown;
  blockedId?: unknown;
}

const key = (value: unknown): string | null => idString(value)?.toLowerCase() ?? null;

/**
 * The other person of a private one-to-one conversation `userId` is in, or
 * null: an order's or a company's conversation, a group, one with more or
 * fewer than two people, or one the caller is not in.
 */
export const privatePeerOf = (conversation: BlockableConversation | null | undefined, userId: string): string | null => {
  if (!conversation) return null;
  const type = conversation.conversationType;
  if (type !== undefined && type !== null && type !== "PRIVATE") return null;
  if (idString(conversation.orderId) || idString(conversation.organizationId)) return null;
  const ids = [...new Set((conversation.participants ?? []).map((participant) => key(participant?.user)).filter((id): id is string => Boolean(id)))];
  const me = key(userId);
  if (ids.length !== 2 || !me || !ids.includes(me)) return null;
  return ids.find((id) => id !== me) ?? null;
};

/** Whether `rows` hold a block between `a` and `b`, in either direction. */
export const isBlockedPair = (rows: readonly (BlockRow | null | undefined)[] | null | undefined, a: string, b: string): boolean => {
  const x = key(a);
  const y = key(b);
  if (!x || !y || x === y) return false;
  return (rows ?? []).some((row) => {
    const blocker = key(row?.blockerId);
    const blocked = key(row?.blockedId);
    return (blocker === x && blocked === y) || (blocker === y && blocked === x);
  });
};

/** Whether `rows` say `blockerId` blocked `blockedId` (this direction only). */
export const hasBlocked = (rows: readonly (BlockRow | null | undefined)[] | null | undefined, blockerId: string, blockedId: string): boolean => {
  const x = key(blockerId);
  const y = key(blockedId);
  return Boolean(x && y) && (rows ?? []).some((row) => key(row?.blockerId) === x && key(row?.blockedId) === y);
};

/**
 * The userblocks filter for "a and b, either direction": one findOne, each
 * branch on the backend's unique {blockerId:1, blockedId:1} index. Null when
 * either id is not an ObjectId (nothing can match).
 */
export const blockedPairFilter = (a: string, b: string) => {
  if (!isObjectIdString(a) || !isObjectIdString(b)) return null;
  const x = new Types.ObjectId(a);
  const y = new Types.ObjectId(b);
  return { $or: [{ blockerId: x, blockedId: y }, { blockerId: y, blockedId: x }] };
};

/**
 * The userblocks filter for the conversation list: every block between
 * `userId` and any of `peerIds`, either direction, in one find (the
 * {blockerId, blockedId} index for "I blocked them", {blockedId} for "they
 * blocked me"). Null when there is nobody to ask about.
 */
export const blocksAroundFilter = (userId: string, peerIds: readonly string[]) => {
  if (!isObjectIdString(userId)) return null;
  const peers = [...new Set(peerIds.filter(isObjectIdString).map((id) => id.toLowerCase()))].map((id) => new Types.ObjectId(id));
  if (peers.length === 0) return null;
  const me = new Types.ObjectId(userId);
  return { $or: [{ blockerId: me, blockedId: { $in: peers } }, { blockedId: me, blockerId: { $in: peers } }] };
};

/**
 * The list's rule: a private conversation is hidden from the caller when the
 * caller blocked its other person. The person who was blocked still sees it
 * (their sends fail).
 */
export const hiddenByBlock = (
  conversation: BlockableConversation | null | undefined,
  userId: string,
  rows: readonly (BlockRow | null | undefined)[] | null | undefined
): boolean => {
  const peer = privatePeerOf(conversation, userId);
  return Boolean(peer) && hasBlocked(rows, userId, peer as string);
};

/** Whether the conversation is a private one between a blocked pair, as `rows` tell it. */
export const blockedConversation = (
  conversation: BlockableConversation | null | undefined,
  userId: string,
  rows: readonly (BlockRow | null | undefined)[] | null | undefined
): boolean => {
  const peer = privatePeerOf(conversation, userId);
  return Boolean(peer) && isBlockedPair(rows, userId, peer as string);
};
