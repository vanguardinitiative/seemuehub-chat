import { getAllMessage, getAllMessageHistory } from "@/controllers/message";
import { IRouter, Router } from "express";
import { checkAuthorizationMiddleware } from "@/middleware";
import { conversationModel } from "@/models/conversation";
import { messageModel } from "@/models/message";
import mongoose, { Schema } from "mongoose";
const messageRoute: IRouter = Router();

const orgMemberSchema = new Schema({ organizationId: Schema.Types.ObjectId, userId: Schema.Types.ObjectId, status: String }, { collection: "organizationmembers" });
const OrgMember = mongoose.models.OrganizationMember ?? mongoose.model("OrganizationMember", orgMemberSchema);

messageRoute.post("/", checkAuthorizationMiddleware, async (req, res) => {
  try {
    const actorUserId = String((req as any).user?.userId ?? (req as any).user?.id);
    const { conversationId, body, content, sendAsOrganizationId } = req.body;
    const conversation: any = await conversationModel.findById(conversationId);
    if (!conversation) return void res.status(404).json({ success: false, errors: { code: "CONVERSATION_NOT_FOUND" } });
    if (sendAsOrganizationId) {
      if (String(conversation.organizationId) !== String(sendAsOrganizationId)) return void res.status(403).json({ success: false, errors: { code: "ORGANIZATION_CONVERSATION_MISMATCH" } });
      const membership = await OrgMember.findOne({ organizationId: sendAsOrganizationId, userId: actorUserId, status: "ACTIVE" }).lean();
      if (!membership) return void res.status(403).json({ success: false, errors: { code: "ORGANIZATION_MEMBERSHIP_REQUIRED" } });
    }
    const message = await messageModel.create({ sender: actorUserId, actorUserId, sendAsOrganizationId, conversation: conversationId, content: body ?? content, messageType: "TEXT" });
    conversation.latestMessageData = { senderId: actorUserId, messageId: String(message._id), content: message.content, sendAt: message.sendAt, isDeleted: false };
    await conversation.save();
    res.status(201).json({ success: true, data: message });
  } catch { res.status(500).json({ success: false, errors: { code: "INTERNAL_EXCEPTION", message: "Something went wrong" } }); }
});

messageRoute.get("/histories", getAllMessageHistory);
messageRoute.get("/", getAllMessage);

export default messageRoute;
