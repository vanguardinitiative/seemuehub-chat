"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMessagesAdmin = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const config_1 = require("../../config/index.js");
const message_1 = require("../../models/message.js");
const getMessagesAdmin = async (req, res) => {
    try {
        const { skip = "0", limit = "100", conversationId } = req.query;
        const skipNumber = Number.parseInt(skip, 10) || 0;
        const limitNumber = Math.min(Number.parseInt(limit, 10) || 100, 200);
        if (!conversationId) {
            res.status(400).json(config_1.messages.CONVERSATION_ID_REQUIRED);
            return;
        }
        if (!mongoose_1.default.Types.ObjectId.isValid(conversationId)) {
            res.status(400).json(config_1.messages.INVALID_CONVERSATION_ID);
            return;
        }
        const [items, total] = await Promise.all([
            message_1.messageModel
                .find({ conversation: conversationId })
                .populate("sender", "userName displayName profileImage")
                .sort({ createdAt: 1 })
                .skip(skipNumber)
                .limit(limitNumber)
                .lean(),
            message_1.messageModel.countDocuments({ conversation: conversationId }),
        ]);
        res.status(200).json({
            code: config_1.messages.SUCCESSFULLY.code,
            message: config_1.messages.SUCCESSFULLY.message,
            data: {
                messages: items,
                pagination: { skip: skipNumber, limit: limitNumber, total },
            },
        });
    }
    catch (error) {
        res.status(500).json(config_1.messages.INTERNAL_SERVER_ERROR);
    }
};
exports.getMessagesAdmin = getMessagesAdmin;
//# sourceMappingURL=admin.js.map