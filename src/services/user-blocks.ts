import { conversationModel } from "@/models/conversation";
import { userBlockModel } from "@/models/user-block";
import {
  blockedPairFilter,
  blocksAroundFilter,
  privatePeerOf,
  type BlockRow,
  type BlockableConversation,
} from "@/utils/user-blocks";

/**
 * User blocks in chat (worktrees/STORE-SAFETY-CONTRACT.md §2.2): the reads
 * of seemuehub-backend's `userblocks` (src/models/user-block.ts). One indexed
 * query per check, never cached: an unblock works at once. The rules are in
 * src/utils/user-blocks.ts.
 */

/** Whether `a` and `b` are a blocked pair: one findOne, either direction. */
export const isPairBlocked = async (a: string, b: string): Promise<boolean> => {
  const filter = blockedPairFilter(a, b);
  if (!filter) return false;
  return Boolean(await userBlockModel.findOne(filter).select("_id").lean());
};

/**
 * Whether `conversation` is a private one-to-one conversation of `userId`'s
 * whose other person and `userId` are a blocked pair. Order, company and group
 * conversations never are, and cost no query.
 */
export const isPrivateConversationBlocked = async (
  conversation: BlockableConversation | null | undefined,
  userId: string
): Promise<boolean> => {
  const peer = privatePeerOf(conversation, userId);
  return peer ? isPairBlocked(userId, peer) : false;
};

/** What isPrivateConversationBlocked reads of a conversation. */
export const BLOCK_CHECK_FIELDS = "conversationType orderId organizationId participants.user";

/**
 * The same by conversation id, for the socket events that only carry one
 * (REACT_MESSAGE, TYPING, DELIVERED): the conversation by its _id, then the
 * one findOne when it is private.
 */
export const blockedInConversation = async (conversationId: string, userId: string): Promise<boolean> => {
  const conversation = (await conversationModel
    .findById(conversationId)
    .select(BLOCK_CHECK_FIELDS)
    .lean()) as BlockableConversation | null;
  return isPrivateConversationBlocked(conversation, userId);
};

/**
 * Every block between `userId` and any of `peerIds`, in either direction:
 * one find, for the conversation list. Empty without peers (no query).
 */
export const blocksAround = async (userId: string, peerIds: readonly string[]): Promise<BlockRow[]> => {
  const filter = blocksAroundFilter(userId, peerIds);
  if (!filter) return [];
  return (await userBlockModel.find(filter).select("blockerId blockedId").lean()) as BlockRow[];
};
