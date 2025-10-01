"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageNotification = exports.createOrGetConversation = void 0;
const conversation_1 = require("../../models/conversation");
const messageStatus_1 = require("../../models/messageStatus");
const user_1 = require("../../models/user");
const axios_1 = __importDefault(require("axios"));
const staff_1 = require("../../models/staff");
const createOrGetConversation = async (senderId, receiverId, session) => {
    const conversation = await conversation_1.conversationModel
        .findOne({
        conversationType: "PRIVATE",
        $and: [{ "participants.user": senderId }, { "participants.user": receiverId }],
    })
        .session(session);
    if (conversation)
        return conversation;
    const chatData = {
        conversationName: "Private",
        conversationType: "PRIVATE",
        participants: [
            { user: senderId, joinDate: new Date() },
            { user: receiverId, joinDate: new Date() },
        ],
    };
    const [newConversation] = await conversation_1.conversationModel.create([chatData], { session });
    return newConversation;
};
exports.createOrGetConversation = createOrGetConversation;
const messageNotification = async (conversationData, messageData) => {
    try {
        const senderId = messageData.sender.toString();
        console.log("senderId", senderId);
        const messageStatusData = conversationData.participants
            .map((participant) => {
            if (participant.user.toString() !== senderId) {
                return {
                    message: messageData._id,
                    user: participant.user,
                    conversation: conversationData._id,
                };
            }
            return null;
        })
            .filter(Boolean);
        await messageStatus_1.messageStatusModel.insertMany(messageStatusData);
        const userChatIds = conversationData?.participants
            ?.filter((participant) => participant.user.toString() !== senderId && !participant.isMuted && participant.userType === conversation_1.UserType.USER)
            ?.map((participant) => participant.user.toString()) || [];
        const isPrivateChat = conversationData?.conversationType === "PRIVATE";
        let senderName = conversationData?.conversationName;
        let senderProfile = conversationData?.conversationImage;
        if (isPrivateChat) {
            const messageDetail = await user_1.userModel.findById(senderId);
            senderName = messageDetail?.fullName;
            senderProfile = messageDetail?.profileImage;
        }
        else {
            const messageDetail = await staff_1.staffModel.findById(senderId);
            senderName = messageDetail?.fullName;
            senderProfile = messageDetail?.profileImage;
        }
        const conversationTitle = isPrivateChat ? senderName : "ສູນຊ່ວຍເຫຼືອ";
        const conversationImage = isPrivateChat ? senderProfile : conversationData?.conversationImage;
        let detailPrefix = isPrivateChat ? "" : `${senderName}: `;
        const messageContentMap = {
            TEXT: messageData.content || "",
            IMAGE: "📷 Sent a photo.",
            VIDEO: "🎦 Sent a video.",
            VOICE: "🎧 Sent a voice message.",
            FILE: "📄 Sent a file.",
            LOCATION: "📍 Sent a location.",
        };
        const content = messageContentMap[messageData.messageType || ""] || "Sent a message.";
        const sendNotificationToUsers = (userIds, isTagged = false) => {
            if (userIds.length === 0)
                return;
            const payload = {
                conversationId: conversationData._id?.toString() ?? "",
                title: conversationTitle || "",
                detail: `${detailPrefix}${isTagged ? `📣 ${content}` : content}`,
                imageProfile: conversationImage || "",
                name: conversationTitle || "",
                conversationType: conversationData.conversationType,
                messageId: messageData._id.toString(),
                imageUrl: messageData.attachments?.[0]?.fileUrl,
                userChatIds: userIds,
                recipient: userIds[0],
                type: "CHAT",
                platform: "TAXI",
                recipientRole: "CUSTOMER",
            };
            sendNotification(payload);
        };
        sendNotificationToUsers(userChatIds);
    }
    catch (error) {
        console.error("Error sending notification:");
    }
};
exports.messageNotification = messageNotification;
const sendNotification = async (messageData) => {
    try {
        console.log("step8");
        console.log("messageData", messageData);
        console.log("process.env.NOTIFICATION_URL===>", process.env.NOTIFICATION_URL);
        await axios_1.default.post(process.env.NOTIFICATION_URL || "localhost", messageData, {
            headers: {
                "Content-Type": "application/json",
            },
        });
    }
    catch (error) {
        console.error("Error sending notification:");
    }
};
//# sourceMappingURL=helper.js.map