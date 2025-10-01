"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAllMessageHistory = exports.getAllMessage = exports.sendGroupMessage = exports.sendPrivateMessage = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const conversation_1 = require("../../models/conversation");
const message_1 = require("../../models/message");
const redis_1 = require("../../config/redis");
const helper_1 = require("./helper");
const config_1 = require("../../config");
const sendPrivateMessage = async (socket, io, data) => {
    const session = await mongoose_1.default.startSession();
    try {
        session.startTransaction();
        if (data._id && !mongoose_1.default.Types.ObjectId.isValid(data._id)) {
            throw new Error("Invalid _id format");
        }
        if (!data.messageType || !data.content || !data.senderId || !data.receiverId) {
            throw new Error("messageType, content, senderId, and receiverId are required");
        }
        const conversation = !data.conversationId
            ? await (0, helper_1.createOrGetConversation)(data.senderId, data.receiverId, session)
            : null;
        const newConversationId = conversation?._id || data.conversationId;
        const customId = data._id ? new mongoose_1.default.Types.ObjectId(data._id) : new mongoose_1.default.Types.ObjectId();
        const [messageData] = await message_1.messageModel.create([
            {
                ...data,
                _id: customId,
                messageType: data.messageType,
                fileUploaded: true,
                sender: data.senderId,
                content: data.content,
                conversation: newConversationId,
                sendAt: new Date(),
                createdAt: new Date(),
            },
        ], { session });
        const conversationData = await conversation_1.conversationModel.findByIdAndUpdate(newConversationId, {
            latestMessageData: {
                senderId: data.senderId,
                messageId: messageData._id,
                content: data.content,
                readAllAt: null,
                sendAt: new Date(),
                deliveredAllAt: new Date(),
            },
        }, { new: true, session });
        redis_1.pub.publish("SEND_MESSAGE", JSON.stringify({
            conversation: conversationData,
            messageData,
        }));
        await session.commitTransaction();
    }
    catch (error) {
        await session.abortTransaction();
        console.error("Error sending message:", error instanceof Error ? error.message : "Unknown error");
        socket.emit("ERROR", { message: error instanceof Error ? error.message : "Unknown error" });
    }
    finally {
        session.endSession();
    }
};
exports.sendPrivateMessage = sendPrivateMessage;
const sendGroupMessage = async (socket, io, data) => {
    const session = await mongoose_1.default.startSession();
    try {
        session.startTransaction();
        if (data._id && !mongoose_1.default.Types.ObjectId.isValid(data._id)) {
            throw new Error("Invalid _id format");
        }
        if (!data.messageType || !data.content || !data.senderId || !data.conversationId) {
            throw new Error("messageType, content, senderId, and receiverId are required");
        }
        const newConversationId = data.conversationId;
        const customId = data._id ? new mongoose_1.default.Types.ObjectId(data._id) : new mongoose_1.default.Types.ObjectId();
        const [messageData] = await message_1.messageModel.create([
            {
                ...data,
                _id: customId,
                messageType: data.messageType,
                fileUploaded: true,
                sender: data.senderId,
                content: data.content,
                conversation: newConversationId,
                sendAt: new Date(),
                createdAt: new Date(),
            },
        ], { session });
        const conversationData = await conversation_1.conversationModel.findByIdAndUpdate(newConversationId, {
            latestMessageData: {
                senderId: data.senderId,
                messageId: messageData._id,
                content: data.content,
                readAllAt: null,
                sendAt: new Date(),
                deliveredAllAt: new Date(),
            },
        }, { new: true, session });
        redis_1.pub.publish("SEND_MESSAGE", JSON.stringify({
            conversation: conversationData,
            messageData,
        }));
        if (conversationData) {
            (0, helper_1.messageNotification)(conversationData, messageData);
        }
        await session.commitTransaction();
    }
    catch (error) {
        await session.abortTransaction();
        console.error("Error sending message:", error instanceof Error ? error.message : "Unknown error");
        socket.emit("ERROR", { message: error instanceof Error ? error.message : "Unknown error" });
    }
    finally {
        session.endSession();
    }
};
exports.sendGroupMessage = sendGroupMessage;
const getAllMessage = async (req, res) => {
    try {
        const { skip = "0", limit = "30", conversationId } = req.query;
        const skipNumber = parseInt(skip, 10);
        const limitNumber = parseInt(limit, 10);
        if (!conversationId) {
            res.status(400).json(config_1.messages.CONVERSATION_ID_REQUIRED);
            return;
        }
        const message = await message_1.messageModel
            .find({ conversation: conversationId })
            .sort({ createdAt: -1 })
            .skip(skipNumber)
            .limit(limitNumber)
            .lean();
        res.status(200).json({
            code: config_1.messages.SUCCESSFULLY.code,
            message: config_1.messages.SUCCESSFULLY.message,
            data: message,
        });
        return;
    }
    catch (error) {
        res.status(500).json(config_1.messages.INTERNAL_SERVER_ERROR);
        return;
    }
};
exports.getAllMessage = getAllMessage;
const getAllMessageHistory = async (req, res) => {
    try {
        const { skip = "0", limit = "30", orderId } = req.query;
        const skipNumber = parseInt(skip, 10);
        const limitNumber = parseInt(limit, 10);
        if (!orderId) {
            res.status(400).json(config_1.messages.CONVERSATION_ID_REQUIRED);
            return;
        }
        const conversation = await conversation_1.conversationModel.findOne({
            orderId: orderId,
        });
        if (!conversation) {
            res.status(404).json(config_1.messages.CONVERSATION_NOT_FOUND);
            return;
        }
        const message = await message_1.messageModel
            .find({ conversation: conversation._id })
            .sort({ createdAt: -1 })
            .skip(skipNumber)
            .limit(limitNumber)
            .lean();
        res.status(200).json({
            code: config_1.messages.SUCCESSFULLY.code,
            message: config_1.messages.SUCCESSFULLY.message,
            data: message,
        });
        return;
    }
    catch (error) {
        res.status(500).json(config_1.messages.INTERNAL_SERVER_ERROR);
        return;
    }
};
exports.getAllMessageHistory = getAllMessageHistory;
//# sourceMappingURL=index.js.map