import { getAllMessage, getAllMessageHistory } from "@/controllers/message";
import { checkAuthorizationMiddleware } from "@/middleware";
import { requireAdminMiddleware } from "@/middleware/admin";
import { getMessagesAdmin } from "@/controllers/message/admin";
import { IRouter, Router } from "express";
import { conversationModel } from "@/models/conversation";
import { messageModel, MessageType } from "@/models/message";
import mongoose, { Schema } from "mongoose";
import { isClientMessageType } from "@/utils/message-type";
import { checkSticker } from "@/utils/sticker";
import { messages } from "@/config";
import { env } from "@/config/env";
const messageRoute: IRouter = Router();

const orgMemberSchema = new Schema(
  { organizationId: Schema.Types.ObjectId, userId: Schema.Types.ObjectId, status: String },
  { collection: "organizationmembers" },
);
const OrgMember = mongoose.models.OrganizationMember ?? mongoose.model("OrganizationMember", orgMemberSchema);

messageRoute.post("/", checkAuthorizationMiddleware, async (req, res) => {
  try {
    const actorUserId = String((req as any).user?.userId ?? (req as any).user?.id);
    const { conversationId, body, content, sendAsOrganizationId, messageType } = req.body;
    // Stored as TEXT whatever is sent, but a request for a server-only type
    // (SYSTEM, ORDER_*) is refused rather than quietly downgraded.
    if (messageType !== undefined && !isClientMessageType(messageType))
      return void res.status(400).json(messages.INVALID_MESSAGE_TYPE);
    // The one exception is a STICKER, which means nothing without its
    // attachment (utils/sticker.ts): one that passes is stored as a STICKER,
    // one that does not is refused before anything is read.
    const sticker = messageType === MessageType.STICKER ? checkSticker(req.body.attachments, env.STICKER_URL_PREFIX) : null;
    if (sticker && !sticker.ok) return void res.status(400).json(messages.INVALID_STICKER);
    const conversation: any = await conversationModel.findById(conversationId);
    if (!conversation) return void res.status(404).json({ success: false, errors: { code: "CONVERSATION_NOT_FOUND" } });
    if (sendAsOrganizationId) {
      if (String(conversation.organizationId) !== String(sendAsOrganizationId))
        return void res.status(403).json({ success: false, errors: { code: "ORGANIZATION_CONVERSATION_MISMATCH" } });
      const membership = await OrgMember.findOne({
        organizationId: sendAsOrganizationId,
        userId: actorUserId,
        status: "ACTIVE",
      }).lean();
      if (!membership)
        return void res.status(403).json({ success: false, errors: { code: "ORGANIZATION_MEMBERSHIP_REQUIRED" } });
    }
    const message = await messageModel.create({
      sender: actorUserId,
      actorUserId,
      sendAsOrganizationId,
      conversation: conversationId,
      ...(sticker?.ok
        ? { content: sticker.content, messageType: MessageType.STICKER, attachments: sticker.attachments, fileUploaded: true }
        : { content: body ?? content, messageType: "TEXT" }),
    });
    conversation.latestMessageData = {
      senderId: actorUserId,
      messageId: String(message._id),
      messageType: message.messageType,
      content: message.content,
      sendAt: message.sendAt,
      isDeleted: false,
    };
    await conversation.save();
    res.status(201).json({ success: true, data: message });
  } catch {
    res.status(500).json({ success: false, errors: { code: "INTERNAL_EXCEPTION", message: "Something went wrong" } });
  }
});
// Both of these returned message bodies to anyone who knew (or guessed) a
// conversation id, with no credential of any kind.
messageRoute.get("/admin", checkAuthorizationMiddleware, requireAdminMiddleware, getMessagesAdmin);
messageRoute.get("/histories", checkAuthorizationMiddleware, getAllMessageHistory);
messageRoute.get("/", checkAuthorizationMiddleware, getAllMessage);

export default messageRoute;
