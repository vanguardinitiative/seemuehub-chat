import type { Request } from "express";
import { Types } from "mongoose";

import { conversationModel } from "@/models/conversation";

/**
 * Who may read a conversation.
 *
 * Membership is the whole authorization model here: a conversation belongs to
 * the people in its `participants` array and to nobody else. These three
 * helpers exist so the four handlers that need that rule cannot drift apart —
 * which is exactly how this went wrong in the first place. `getAllConversions`
 * scoped its query by the caller from day one; `getConversation` and the two
 * message handlers simply never did, and nothing tied them together.
 */

/**
 * The membership rule as a *query filter*, never as a check after the fetch.
 *
 * A post-fetch check means the document is already in memory and one stray
 * early `return` away from being serialised to a stranger. Folding it into the
 * query makes "you are not a participant" and "it does not exist" the same code
 * path — which is also the response we want (see the 404 note in the handlers).
 *
 * Free at read time: `participants.user` carries a field-level index plus the
 * compounds {"participants.user":1, orderId:1} and
 * {"participants.user":1, conversationType:1}.
 */
export const participantOf = (userId: string) => ({
  "participants.user": new Types.ObjectId(userId),
});

/**
 * The caller's id, as `checkAuthorizationMiddleware` recorded it.
 *
 * The main API signs `jwt.sign({ userId }, …)`, so `userId` is the field — the
 * same one `getAllConversions` has always read. Anything that is not a usable
 * ObjectId returns null so the caller can answer 401 rather than hand Mongo a
 * value that throws a CastError and surfaces as a 500.
 */
export const userIdOf = (req: Request): string | null => {
  const id = (req as any).user?.userId;
  return typeof id === "string" && Types.ObjectId.isValid(id) ? id : null;
};

/**
 * Membership probe for the message endpoints.
 *
 * `messageModel.find({ conversation })` has no participants array of its own to
 * filter on, so membership has to be established against the conversation
 * first. That is one `findOne` on the primary index projected down to `_id` —
 * cheaper than the alternatives (an aggregation with `$lookup`, or
 * denormalising the participant list onto every message), and cheaper than the
 * paginated message query it is guarding.
 */
export const isParticipant = async (conversationId: string, userId: string): Promise<boolean> =>
  Boolean(
    await conversationModel
      .findOne({ _id: conversationId, ...participantOf(userId) })
      .select("_id")
      .lean()
  );
