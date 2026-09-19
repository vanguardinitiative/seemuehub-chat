"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const mongoose_1 = __importStar(require("mongoose"));
const middleware_1 = require("../middleware");
const conversation_1 = require("../models/conversation");
const message_1 = require("../models/message");
const router = (0, express_1.Router)();
const memberSchema = new mongoose_1.Schema({ organizationId: mongoose_1.Schema.Types.ObjectId, userId: mongoose_1.Schema.Types.ObjectId, role: String, status: String }, { collection: "organizationmembers" });
const Member = mongoose_1.default.models.OrganizationMember ?? mongoose_1.default.model("OrganizationMember", memberSchema);
const uid = (req) => String(req.user?.userId ?? req.user?.id);
const requireMember = async (organizationId, userId) => Member.findOne({ organizationId, userId, status: "ACTIVE" }).lean();
router.use(middleware_1.checkAuthorizationMiddleware);
router.get("/:id/conversations", async (req, res) => {
    try {
        if (!(await requireMember(req.params.id, uid(req))))
            return void res.status(403).json({ success: false, errors: { code: "ORGANIZATION_MEMBERSHIP_REQUIRED", message: "Active organization membership is required" } });
        const skip = Math.max(0, Number(req.query.skip ?? 0)), limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
        const conversations = await conversation_1.conversationModel.find({ organizationId: req.params.id }).populate("participants.user", "fullName userName displayName email profileImage").sort({ updatedAt: -1 }).skip(skip).limit(limit).lean();
        res.json({ success: true, data: { conversations } });
    }
    catch (error) {
        res.status(500).json({ success: false, errors: { code: "INTERNAL_EXCEPTION", message: "Something went wrong" } });
    }
});
router.post("/:id/conversations", async (req, res) => {
    try {
        const actor = uid(req);
        if (!(await requireMember(req.params.id, actor)))
            return void res.status(403).json({ success: false, errors: { code: "ORGANIZATION_MEMBERSHIP_REQUIRED" } });
        const { participantUserId, applicationId } = req.body;
        if (!mongoose_1.default.isValidObjectId(participantUserId))
            return void res.status(400).json({ success: false, errors: { code: "VALIDATION_ERROR", message: "participantUserId is required" } });
        let item = await conversation_1.conversationModel.findOne({ organizationId: req.params.id, applicationId: applicationId || null, "participants.user": participantUserId });
        if (!item)
            item = await conversation_1.conversationModel.create({ organizationId: req.params.id, applicationId, conversationType: "PRIVATE", conversationName: "ORGANIZATION_CONVERSATION", participants: [{ user: participantUserId, userType: "USER" }], latestMessageData: { isDeleted: false } });
        res.status(201).json({ success: true, data: item });
    }
    catch (error) {
        res.status(500).json({ success: false, errors: { code: "INTERNAL_EXCEPTION", message: "Something went wrong" } });
    }
});
router.post("/conversations/:conversationId/messages", async (req, res) => {
    try {
        const actor = uid(req), conversation = await conversation_1.conversationModel.findById(req.params.conversationId);
        if (!conversation)
            return void res.status(404).json({ success: false, errors: { code: "CONVERSATION_NOT_FOUND" } });
        if (!conversation.organizationId || !(await requireMember(String(conversation.organizationId), actor)))
            return void res.status(403).json({ success: false, errors: { code: "ORGANIZATION_MEMBERSHIP_REQUIRED" } });
        const item = await message_1.messageModel.create({ sender: actor, actorUserId: actor, sendAsOrganizationId: conversation.organizationId, conversation: conversation._id, content: req.body.body ?? req.body.content, messageType: "TEXT" });
        conversation.latestMessageData = { senderId: actor, messageId: String(item._id), content: item.content, sendAt: item.sendAt, isDeleted: false };
        await conversation.save();
        res.status(201).json({ success: true, data: item });
    }
    catch (error) {
        res.status(500).json({ success: false, errors: { code: "INTERNAL_EXCEPTION", message: "Something went wrong" } });
    }
});
exports.default = router;
//# sourceMappingURL=organization.js.map