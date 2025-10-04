"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateReadStatus = void 0;
const message_1 = require("../../models/message");
const messageStatus_1 = require("../../models/messageStatus");
const config_1 = require("../../config");
const conversation_1 = require("../../models/conversation");
const redis_1 = require("../../config/redis");
const updateReadStatus = async (req, res) => {
    try {
        console.log("user data", req.user);
        const { conversationId } = req.query;
        if (!conversationId) {
            res.status(400).json(config_1.messages.BAD_REQUEST);
            return;
        }
        const receiverId = req.user.userId;
        const conversation = await conversation_1.conversationModel.findById(conversationId);
        if (!conversation) {
            res.status(404).json(config_1.messages.NOT_FOUND);
            return;
        }
        console.log("conversation", conversation.latestMessageData.senderId);
        const userData = conversation.participants.find((participant) => participant.user.toString() == conversation.latestMessageData.senderId);
        console.log("userData", userData);
        if (!userData) {
            res.status(404).json(config_1.messages.NOT_FOUND);
            return;
        }
        let userIds = [];
        if (userData?.userType === conversation_1.UserType.USER) {
            if (conversation.conversationType == "PRIVATE") {
                userIds = conversation.participants
                    .filter((participant) => participant.user.toString() !== receiverId)
                    .map((participant) => participant.user.toString());
            }
            else {
                userIds = conversation.participants
                    .filter((participant) => participant.userType === conversation_1.UserType.ADMIN)
                    .map((participant) => participant.user.toString());
            }
        }
        else if (userData.userType === conversation_1.UserType.ADMIN) {
            userIds = conversation.participants
                .filter((participant) => participant.userType === conversation_1.UserType.USER)
                .map((participant) => participant.user.toString());
        }
        const messagesData = await message_1.messageModel.findOne({
            _id: conversation.latestMessageData.messageId,
            readAllAt: null,
        });
        console.log("messagesData", messagesData);
        if (!messagesData) {
            res.status(200).json({
                code: config_1.messages.SUCCESSFULLY.code,
                message: config_1.messages.SUCCESSFULLY.message,
                data: {},
            });
            return;
        }
        const currentTime = Date.now();
        await messageStatus_1.messageStatusModel.updateMany({
            user: receiverId,
            status: "UNREAD",
            conversation: conversationId,
        }, {
            readAt: currentTime,
            status: "READ",
        });
        console.log("userIds", userIds);
        const messageStatusData = await messageStatus_1.messageStatusModel.find({
            conversation: conversationId,
            message: messagesData._id,
            status: "READ",
            user: { $in: userIds },
        });
        if (messageStatusData.length === 0) {
            res.status(200).json({
                code: config_1.messages.SUCCESSFULLY.code,
                message: config_1.messages.SUCCESSFULLY.message,
                data: {},
            });
            return;
        }
        await Promise.all([
            message_1.messageModel.updateMany({ conversation: conversationId, readAllAt: null }, { readAllAt: currentTime }),
            conversation_1.conversationModel.updateOne({ _id: conversationId }, { "latestMessageData.readAllAt": currentTime }),
            messageStatus_1.messageStatusModel.updateMany({ conversation: conversationId, status: "UNREAD" }, { status: "READ", readAt: currentTime }),
        ]);
        redis_1.pub.publish("READ_MESSAGE", JSON.stringify({
            userIds: conversation.participants.map((participant) => participant.user.toString()),
            conversationId,
        }));
        res.status(200).json({
            code: config_1.messages.SUCCESSFULLY.code,
            message: config_1.messages.SUCCESSFULLY.message,
            data: { conversationId },
        });
        return;
    }
    catch (error) {
        console.error("Error updating read status:", error);
        res.status(500).json(config_1.messages.INTERNAL_SERVER_ERROR);
        return;
    }
};
exports.updateReadStatus = updateReadStatus;
//# sourceMappingURL=index.js.map