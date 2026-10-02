import { Types } from "mongoose";
import { conversationModel } from "@/models/conversation";
import { pub } from "@/config/redis";
import { logEvent } from "@/socket/auth";
import { participantOf } from "@/utils/conversation-access";
import {
  deliveryMoves,
  needsDelivery,
  otherParticipants,
  withDelivered,
  type DeliveredConversation,
  type DeliveredNotice,
} from "@/utils/delivered";

/**
 * The delivered-state writes (worktrees/CHAT-CONTRACT.md §5.1). Every one is
 * a $max on the caller's own `participants[].lastDeliveredAt`, filtered by
 * membership, with timestamps off (the list sorts by updatedAt). The read PUT
 * does its own, in the same update as its read mark
 * (controllers/messageStatus).
 */

/** The fields a delivery decision reads. */
export const DELIVERY_FIELDS = "participants.user participants.lastDeliveredAt latestMessageData.senderId latestMessageData.sendAt";

const deliveredUpdate = (at: Date) => ({ $max: { "participants.$[me].lastDeliveredAt": at } });
const deliveredOptions = (userId: string) => ({
  arrayFilters: [{ "me.user": new Types.ObjectId(userId) }],
  timestamps: false,
});

/** Publishes DELIVERED to the other participants; nothing when there is nobody to tell. */
export const publishDelivered = (notice: DeliveredNotice): void => {
  if (notice.userIds.length === 0) return;
  void pub.publish("DELIVERED", JSON.stringify(notice));
};

/**
 * GET /conversations: the caller has received every conversation on the page
 * it is about to be sent. One updateMany for those with something to
 * deliver (none: no write at all), then DELIVERED for each, and the page's
 * copies show the new mark. Never throws: a failed write is logged and the
 * GET goes on.
 */
export const deliverPage = async (
  conversations: DeliveredConversation[],
  userId: string,
  now: Date = new Date()
): Promise<void> => {
  try {
    const due = conversations.filter((conversation) => needsDelivery(conversation, userId));
    if (due.length === 0) return;
    await conversationModel.updateMany(
      { _id: { $in: due.map((conversation) => conversation._id) }, ...participantOf(userId) },
      deliveredUpdate(now),
      deliveredOptions(userId)
    );
    for (const conversation of due) {
      const moved = deliveryMoves(conversation, userId, now);
      withDelivered(conversation, userId, now);
      if (moved) {
        publishDelivered({
          userIds: otherParticipants(conversation, userId),
          conversationId: String(conversation._id),
          userId,
          deliveredAt: now.toISOString(),
        });
      }
    }
  } catch (error) {
    logEvent({ msg: "delivered_write_failed", path: "GET /conversations", userId, error: error instanceof Error ? error.message : String(error) });
  }
};

/**
 * GET /messages?conversationId=: the same for that one conversation, read
 * with DELIVERY_FIELDS by the membership check. Never throws.
 */
export const deliverConversation = async (
  conversation: DeliveredConversation,
  userId: string,
  now: Date = new Date()
): Promise<void> => {
  try {
    if (!needsDelivery(conversation, userId)) return;
    await conversationModel.updateOne(
      { _id: conversation._id, ...participantOf(userId) },
      deliveredUpdate(now),
      deliveredOptions(userId)
    );
    if (deliveryMoves(conversation, userId, now)) {
      publishDelivered({
        userIds: otherParticipants(conversation, userId),
        conversationId: String(conversation._id),
        userId,
        deliveredAt: now.toISOString(),
      });
    }
    withDelivered(conversation, userId, now);
  } catch (error) {
    logEvent({ msg: "delivered_write_failed", path: "GET /messages", userId, error: error instanceof Error ? error.message : String(error) });
  }
};

/**
 * The socket's DELIVERED write: `at` as the caller's mark, returning the
 * conversation as it was before (so the handler can tell whether this write
 * moved the mark past the latest message), or null when the caller is not a
 * participant.
 */
export const writeDelivered = async (conversationId: string, userId: string, at: Date): Promise<DeliveredConversation | null> =>
  (await conversationModel
    .findOneAndUpdate({ _id: conversationId, ...participantOf(userId) }, deliveredUpdate(at), {
      ...deliveredOptions(userId),
      returnDocument: "before",
    })
    .select(DELIVERY_FIELDS)
    .lean()) as DeliveredConversation | null;
