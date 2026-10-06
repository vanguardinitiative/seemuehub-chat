import { getAllMessage, getAllMessageHistory } from "@/controllers/message";
import { checkAuthorizationMiddleware } from "@/middleware";
import { requireAdminMiddleware } from "@/middleware/admin";
import { getMessagesAdmin } from "@/controllers/message/admin";
import { IRouter, Router } from "express";
import { conversationModel } from "@/models/conversation";
import { messageModel, MessageType } from "@/models/message";
import { isClientMessageType } from "@/utils/message-type";
import { checkSticker } from "@/utils/sticker";
import { messages, withErrorCode } from "@/config";
import { env } from "@/config/env";
import { participantOf } from "@/utils/conversation-access";
import { isObjectIdString } from "@/utils/ids";
import { isBlocked, organizationOf } from "@/utils/org-chat";
import { OrgChatRefusal, announceOrgMessage, sendAsOrganization } from "@/services/org-chat";
import { ORDER_COMPLETED_MESSAGE, isCompletedOrderChat } from "@/utils/order-chat";
const messageRoute: IRouter = Router();

/** POST /messages' refusals: `{ success: false, errors: { code, message } }`, the type and sticker ones with their CHAT-400 fields too. */
const refused = (code: string, message: string) => ({ success: false, errors: { code, message } });
const invalid = (code: "INVALID_MESSAGE_TYPE" | "INVALID_STICKER") => ({ success: false, ...withErrorCode(messages[code], code) });
const NOT_FOUND = refused("CONVERSATION_NOT_FOUND", "Conversation not found");

messageRoute.post("/", checkAuthorizationMiddleware, async (req, res) => {
  try {
    const actorUserId = String((req as any).user?.userId ?? (req as any).user?.id);
    const { conversationId, body, content, sendAsOrganizationId, messageType } = req.body;
    // Stored as TEXT whatever is sent, but a request for a server-only type
    // (SYSTEM, ORDER_*, AGENT) is refused rather than quietly downgraded.
    if (messageType !== undefined && !isClientMessageType(messageType))
      return void res.status(400).json(invalid("INVALID_MESSAGE_TYPE"));
    // The one exception is a STICKER, which means nothing without its
    // attachment (utils/sticker.ts): one that passes is stored as a STICKER,
    // one that does not is refused before anything is read.
    const sticker = messageType === MessageType.STICKER ? checkSticker(req.body.attachments, env.STICKER_URL_PREFIX) : null;
    if (sticker && !sticker.ok) return void res.status(400).json(invalid("INVALID_STICKER"));
    if (!isObjectIdString(conversationId))
      return void res.status(404).json(NOT_FOUND);

    // A member answering for the company: the organization routes' send
    // (src/services/org-chat.ts), which checks the member and the block.
    if (sendAsOrganizationId) {
      const conversation = await conversationModel.findById(conversationId).select("organizationId").lean();
      if (!conversation) return void res.status(404).json(NOT_FOUND);
      if (String(conversation.organizationId) !== String(sendAsOrganizationId))
        return void res
          .status(403)
          .json(refused("ORGANIZATION_CONVERSATION_MISMATCH", "This conversation is not that organization's"));
      const message = await sendAsOrganization(conversationId, actorUserId, req.body);
      return void res.status(201).json({ success: true, data: message });
    }

    // Anyone else writes as themselves, into a conversation they are in. This
    // used to take any conversation id from any signed-in user.
    const conversation: any = await conversationModel
      .findOne({ _id: conversationId, ...participantOf(actorUserId) })
      .select("_id organizationId candidateUserId candidateBlockedAt participants orderStatus")
      .lean();
    if (!conversation) return void res.status(404).json(NOT_FOUND);
    // The candidate blocked this company: neither side writes in it again.
    if (isBlocked(conversation))
      return void res.status(403).json(refused("ORG_CHAT_BLOCKED", "ທ່ານໄດ້ບລັອກບໍລິສັດນີ້ແລ້ວ"));
    // The order is COMPLETED: its chat no longer takes the parties' messages
    // (CHAT-CONTRACT.md §1.10). Nothing is stored or announced.
    if (isCompletedOrderChat(conversation))
      return void res.status(403).json(refused("ORDER_COMPLETED", ORDER_COMPLETED_MESSAGE));

    const message = await messageModel.create({
      sender: actorUserId,
      actorUserId,
      conversation: conversationId,
      ...(sticker?.ok
        ? { content: sticker.content, messageType: MessageType.STICKER, attachments: sticker.attachments, fileUploaded: true }
        : { content: body ?? content, messageType: "TEXT" }),
    });
    // An update, not .save() (CHAT-CONTRACT.md §1.1). A new message does move
    // the conversation up, so timestamps stay on.
    const updated = await conversationModel
      .findOneAndUpdate(
        { _id: conversation._id },
        {
          $set: {
            latestMessageData: {
              senderId: actorUserId,
              messageId: String(message._id),
              messageType: message.messageType,
              content: message.content,
              sendAt: message.sendAt,
              readAllAt: null,
              isDeleted: false,
            },
          },
        },
        { new: true }
      )
      .lean();
    // A candidate answering a company: its inbox and its members' phones hear
    // it (ORG-CHAT-CONTRACT.md §3.2). Other conversations stay as they were.
    if (organizationOf(updated)) announceOrgMessage(JSON.parse(JSON.stringify(updated)), JSON.parse(JSON.stringify(message)));
    res.status(201).json({ success: true, data: message });
  } catch (error) {
    if (error instanceof OrgChatRefusal) {
      if (error.code === "INVALID_MESSAGE_TYPE" || error.code === "INVALID_STICKER") return void res.status(400).json(invalid(error.code));
      return void res.status(error.status).json(refused(error.code, error.message));
    }
    res.status(500).json(refused("INTERNAL_EXCEPTION", "Something went wrong"));
  }
});
// Both of these returned message bodies to anyone who knew (or guessed) a
// conversation id, with no credential of any kind.
messageRoute.get("/admin", checkAuthorizationMiddleware, requireAdminMiddleware, getMessagesAdmin);
messageRoute.get("/histories", checkAuthorizationMiddleware, getAllMessageHistory);
messageRoute.get("/", checkAuthorizationMiddleware, getAllMessage);

export default messageRoute;
