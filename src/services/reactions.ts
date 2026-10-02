import { Types } from "mongoose";
import { messageModel } from "@/models/message";
import { reactionUpdate, type Reaction, type ReactionTarget, type StoredReaction } from "@/utils/reactions";

/**
 * REACT_MESSAGE's reads and its one write (worktrees/CHAT-CONTRACT.md §3.3),
 * wired into the socket handlers by config/socket.ts.
 */

/** What REACT_MESSAGE needs to know about the message before it writes. */
export const findReactionTarget = async (messageId: string): Promise<ReactionTarget | null> =>
  (await messageModel
    .findById(messageId)
    .select("_id conversation sender messageType isDeleted isOrderMessage")
    .lean()) as ReactionTarget | null;

/**
 * Replaces `userId`'s reaction on the message with `emoji` (null removes it),
 * in one pipeline update with timestamps off: the message's `updatedAt`, its
 * conversation, `latestMessageData`, `readAllAt` and unread state are never
 * touched.
 *
 * A findOneAndUpdate rather than an updateOne so the write itself hands back
 * the list it ran on (`returnDocument: "before"`). From that pre-image the
 * caller knows exactly what it replaced (for the push) and exactly what is
 * stored now (utils/reactions.ts applyReaction, the same rule in JS), even
 * when someone else reacts to the same message at the same moment.
 *
 * The filter repeats the deleted / order-message checks, so a message deleted
 * between the check and the write is left alone (null).
 */
export const writeReaction = async (
  messageId: string,
  userId: string,
  emoji: Reaction | null,
  at: Date
): Promise<{ reactions?: StoredReaction[] | null } | null> =>
  (await messageModel
    .findOneAndUpdate(
      { _id: new Types.ObjectId(messageId), isDeleted: { $ne: true }, isOrderMessage: { $ne: true } },
      reactionUpdate(userId, emoji, at),
      { returnDocument: "before", timestamps: false }
    )
    .select("reactions")
    .lean()) as { reactions?: StoredReaction[] | null } | null;
