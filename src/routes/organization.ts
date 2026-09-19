import { Router, type Request, type Response } from "express";
import mongoose, { Schema } from "mongoose";
import { checkAuthorizationMiddleware } from "@/middleware";
import { conversationModel } from "@/models/conversation";
import { messageModel } from "@/models/message";

const router = Router();
const memberSchema = new Schema({ organizationId: Schema.Types.ObjectId, userId: Schema.Types.ObjectId, role: String, status: String }, { collection: "organizationmembers" });
const Member = mongoose.models.OrganizationMember ?? mongoose.model("OrganizationMember", memberSchema);
const uid = (req: Request) => String((req as any).user?.userId ?? (req as any).user?.id);
const requireMember = async (organizationId: string, userId: string) => Member.findOne({ organizationId, userId, status: "ACTIVE" }).lean();

router.use(checkAuthorizationMiddleware);
router.get("/:id/conversations", async (req: Request, res: Response) => {
  try {
    if (!(await requireMember(req.params.id, uid(req)))) return void res.status(403).json({ success: false, errors: { code: "ORGANIZATION_MEMBERSHIP_REQUIRED", message: "Active organization membership is required" } });
    const skip = Math.max(0, Number(req.query.skip ?? 0)), limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
    const conversations = await conversationModel.find({ organizationId: req.params.id }).populate("participants.user", "fullName userName displayName email profileImage").sort({ updatedAt: -1 }).skip(skip).limit(limit).lean();
    res.json({ success: true, data: { conversations } });
  } catch (error) { res.status(500).json({ success: false, errors: { code: "INTERNAL_EXCEPTION", message: "Something went wrong" } }); }
});
router.post("/:id/conversations", async (req: Request, res: Response) => {
  try {
    const actor = uid(req); if (!(await requireMember(req.params.id, actor))) return void res.status(403).json({ success: false, errors: { code: "ORGANIZATION_MEMBERSHIP_REQUIRED" } });
    const { participantUserId, applicationId } = req.body; if (!mongoose.isValidObjectId(participantUserId)) return void res.status(400).json({ success: false, errors: { code: "VALIDATION_ERROR", message: "participantUserId is required" } });
    let item = await conversationModel.findOne({ organizationId: req.params.id, applicationId: applicationId || null, "participants.user": participantUserId });
    if (!item) item = await conversationModel.create({ organizationId: req.params.id, applicationId, conversationType: "PRIVATE", conversationName: "ORGANIZATION_CONVERSATION", participants: [{ user: participantUserId, userType: "USER" }], latestMessageData: { isDeleted: false } });
    res.status(201).json({ success: true, data: item });
  } catch (error) { res.status(500).json({ success: false, errors: { code: "INTERNAL_EXCEPTION", message: "Something went wrong" } }); }
});
router.post("/conversations/:conversationId/messages", async (req: Request, res: Response) => {
  try {
    const actor = uid(req), conversation: any = await conversationModel.findById(req.params.conversationId); if (!conversation) return void res.status(404).json({ success: false, errors: { code: "CONVERSATION_NOT_FOUND" } });
    if (!conversation.organizationId || !(await requireMember(String(conversation.organizationId), actor))) return void res.status(403).json({ success: false, errors: { code: "ORGANIZATION_MEMBERSHIP_REQUIRED" } });
    const item = await messageModel.create({ sender: actor, actorUserId: actor, sendAsOrganizationId: conversation.organizationId, conversation: conversation._id, content: req.body.body ?? req.body.content, messageType: "TEXT" });
    conversation.latestMessageData = { senderId: actor, messageId: String(item._id), content: item.content, sendAt: item.sendAt, isDeleted: false }; await conversation.save();
    res.status(201).json({ success: true, data: item });
  } catch (error) { res.status(500).json({ success: false, errors: { code: "INTERNAL_EXCEPTION", message: "Something went wrong" } }); }
});
export default router;
