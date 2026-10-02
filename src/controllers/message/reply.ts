import mongoose from "mongoose";
import { messageModel } from "@/models/message";
import { logEvent } from "@/socket/auth";
import { asksForReply, buildReplyPreview, replyDropReason, type ReplyPreview, type ReplyTarget } from "@/utils/reply";

/**
 * The reply fields a NEW_MESSAGE / NEW_GROUP_MESSAGE is stored with
 * (CHAT-CONTRACT.md §2.2), decided once its conversation is resolved.
 *
 * These are always written over whatever the payload carried, so a client can
 * neither mark a message `isReply` without a valid target nor supply its own
 * preview (the socket also strips `replyPreview`, see RESERVED_MESSAGE_FIELDS).
 */
export type ReplyFields =
  | { isReply: true; replyTo: mongoose.Types.ObjectId; replyPreview: ReplyPreview }
  | { isReply: false; replyTo: undefined; replyPreview: undefined };

const NO_REPLY: ReplyFields = { isReply: false, replyTo: undefined, replyPreview: undefined };

/** What a target lookup reads: enough to check it and to build its preview. */
const TARGET_FIELDS = "_id conversation sender messageType content attachments isDeleted isOrderMessage";

/**
 * Looks up `replyTo` (in the send's session) and decides. An invalid reply is
 * not an error: it is dropped, the message is delivered as a normal one, and
 * `reply_dropped` is logged with why.
 */
export const resolveReply = async (
  replyTo: unknown,
  conversationId: unknown,
  // null outside a transaction: a company message (src/services/org-chat.ts).
  session: mongoose.ClientSession | null,
  context: { event: "NEW_MESSAGE" | "NEW_GROUP_MESSAGE" | "ORG_MESSAGE"; socketId?: string; userId?: string }
): Promise<ReplyFields> => {
  if (!asksForReply(replyTo)) return NO_REPLY;

  let target: ReplyTarget | null = null;
  if (typeof replyTo === "string" && mongoose.Types.ObjectId.isValid(replyTo)) {
    target = (await messageModel.findOne({ _id: replyTo }).select(TARGET_FIELDS).session(session).lean()) as ReplyTarget | null;
  }

  const reason = replyDropReason(replyTo, target, conversationId);
  if (reason) {
    logEvent({
      msg: "reply_dropped",
      event: context.event,
      reason,
      socketId: context.socketId ?? null,
      userId: context.userId ?? null,
      conversationId: conversationId ? String(conversationId) : null,
      replyTo: typeof replyTo === "string" ? replyTo.slice(0, 40) : null,
    });
    return NO_REPLY;
  }

  return {
    isReply: true,
    replyTo: new mongoose.Types.ObjectId(replyTo as string),
    replyPreview: buildReplyPreview(target as ReplyTarget),
  };
};
