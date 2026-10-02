import type { Request } from "express";
import { Types } from "mongoose";

import { conversationModel } from "@/models/conversation";
import { env } from "@/config/env";
import { orgRoomOf } from "@/socket/rooms";
import { idString } from "@/utils/ids";

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

/**
 * Everyone who shares a conversation with `userId`, not counting `userId`:
 * the audience for that user's online/offline presence. One `distinct` at
 * SETUP, found through the `participants.user` index; the result is kept on
 * the socket for the disconnect.
 */
export const conversationPartners = async (userId: string): Promise<string[]> => {
  const ids = await conversationModel.distinct("participants.user", participantOf(userId));
  return ids.map((id) => String(id)).filter((id) => id !== userId);
};

/** A participant as the socket events need one. */
export interface ConversationMember {
  userId: string;
  isMuted: boolean;
}

/**
 * The participants of `conversationId` when `userId` is one of them, and null
 * when not (or when there is no such conversation): the membership check and
 * the audience in one membership-filtered `findOne`. REACT_MESSAGE sends its
 * REACTION to these and checks the author's `isMuted` before a push; TYPING
 * caches them per socket.
 */
export const membersOf = async (conversationId: string, userId: string): Promise<ConversationMember[] | null> => {
  const conversation = await conversationModel
    .findOne({ _id: conversationId, ...participantOf(userId) })
    .select("participants.user participants.isMuted")
    .lean();
  if (!conversation) return null;
  const members = new Map<string, ConversationMember>();
  for (const participant of conversation.participants ?? []) {
    const id = idString(participant?.user);
    if (id && !members.has(id)) members.set(id, { userId: id, isMuted: participant.isMuted === true });
  }
  return [...members.values()];
};

/**
 * TYPING's audience (socket/handlers.ts): `membersOf` plus company
 * conversations (ORG-CHAT-CONTRACT.md §3.4). One findOne, still with access in
 * the filter: the caller must be a participant, or be in the org room
 * (joined at SETUP after the backend's LIST) of the conversation's
 * organization.
 *
 * - A participant hears as before; in a company conversation (the
 *   candidate), the company's org room hears them too.
 * - A member typing for the company is heard by the participants (the
 *   candidate).
 * - Anyone else: null. With ORG_CHAT_ENABLED off, exactly membersOf.
 */
export const audienceOf = async (
  conversationId: string,
  userId: string,
  orgRooms: readonly string[]
): Promise<{ participant: boolean; others: string[]; orgRoom: string | null } | null> => {
  const enabled = env.ORG_CHAT_ENABLED === "true";
  const organizationIds = enabled
    ? orgRooms
        .filter((room) => /^org:[0-9a-f]{24}$/.test(room))
        .map((room) => new Types.ObjectId(room.slice("org:".length)))
    : [];
  const conversation = await conversationModel
    .findOne({
      _id: conversationId,
      ...(organizationIds.length > 0
        ? { $or: [participantOf(userId), { organizationId: { $in: organizationIds } }] }
        : participantOf(userId)),
    })
    .select("participants.user organizationId")
    .lean();
  if (!conversation) return null;

  const ids = [...new Set((conversation.participants ?? []).map((participant) => idString(participant?.user)).filter((id): id is string => Boolean(id)))];
  const participant = ids.includes(userId);
  const orgRoom = enabled ? orgRoomOf(conversation.organizationId) : null;
  if (participant) return { participant: true, others: ids.filter((id) => id !== userId), orgRoom };
  // Matched through the org room: a member typing for the company.
  return orgRoom ? { participant: false, others: ids, orgRoom: null } : null;
};
