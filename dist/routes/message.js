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
const message_1 = require("../controllers/message/index.js");
const middleware_1 = require("../middleware/index.js");
const admin_1 = require("../middleware/admin.js");
const admin_2 = require("../controllers/message/admin.js");
const express_1 = require("express");
const conversation_1 = require("../models/conversation.js");
const message_2 = require("../models/message.js");
const mongoose_1 = __importStar(require("mongoose"));
const messageRoute = (0, express_1.Router)();
const orgMemberSchema = new mongoose_1.Schema({ organizationId: mongoose_1.Schema.Types.ObjectId, userId: mongoose_1.Schema.Types.ObjectId, status: String }, { collection: "organizationmembers" });
const OrgMember = mongoose_1.default.models.OrganizationMember ?? mongoose_1.default.model("OrganizationMember", orgMemberSchema);
messageRoute.post("/", middleware_1.checkAuthorizationMiddleware, async (req, res) => {
    try {
        const actorUserId = String(req.user?.userId ?? req.user?.id);
        const { conversationId, body, content, sendAsOrganizationId } = req.body;
        const conversation = await conversation_1.conversationModel.findById(conversationId);
        if (!conversation)
            return void res.status(404).json({ success: false, errors: { code: "CONVERSATION_NOT_FOUND" } });
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
        const message = await message_2.messageModel.create({
            sender: actorUserId,
            actorUserId,
            sendAsOrganizationId,
            conversation: conversationId,
            content: body ?? content,
            messageType: "TEXT",
        });
        conversation.latestMessageData = {
            senderId: actorUserId,
            messageId: String(message._id),
            content: message.content,
            sendAt: message.sendAt,
            isDeleted: false,
        };
        await conversation.save();
        res.status(201).json({ success: true, data: message });
    }
    catch {
        res.status(500).json({ success: false, errors: { code: "INTERNAL_EXCEPTION", message: "Something went wrong" } });
    }
});
messageRoute.get("/admin", middleware_1.checkAuthorizationMiddleware, admin_1.requireAdminMiddleware, admin_2.getMessagesAdmin);
messageRoute.get("/histories", middleware_1.checkAuthorizationMiddleware, message_1.getAllMessageHistory);
messageRoute.get("/", middleware_1.checkAuthorizationMiddleware, message_1.getAllMessage);
exports.default = messageRoute;
//# sourceMappingURL=message.js.map