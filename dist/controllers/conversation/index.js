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
exports.getAllConversions = exports.getConversation = exports.createGroupConversation = exports.createPrivateConversation = void 0;
const config_1 = require("../../config");
const conversation_1 = require("../../models/conversation");
const messageStatus_1 = require("../../models/messageStatus");
const staff_1 = require("../../models/staff");
const user_1 = require("../../models/user");
const mongoose_1 = __importStar(require("mongoose"));
const createPrivateConversation = async (req, res) => {
    try {
        const { senderId, receiverId, orderId, orderStatus, orderTitle, orderBudget, orderDeadline, orderPriority } = req.body;
        if (!senderId || !receiverId) {
            res.status(400).json(config_1.messages.BAD_REQUEST);
            return;
        }
        if (senderId === receiverId) {
            res.status(400).json(config_1.messages.SELF_CONVERSATION_NOT_ALLOWED);
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const existingConversation = await conversation_1.conversationModel
            .findOne({
            conversationType: "PRIVATE",
            orderId: orderId,
            participants: {
                $all: [{ $elemMatch: { user: senderId } }, { $elemMatch: { user: receiverId } }],
            },
        })
            .populate("participants.user", "fullName phone email role profileImage");
        res.status(201).json({
            code: config_1.messages.CREATE_SUCCESSFUL.code,
            message: config_1.messages.CREATE_SUCCESSFUL.message,
            data: existingConversation,
        });
        return;
    }
    catch (error) {
        console.log("Error creating private conversation:", error);
        res.status(500).json(config_1.messages.INTERNAL_SERVER_ERROR);
        return;
    }
};
exports.createPrivateConversation = createPrivateConversation;
const createGroupConversation = async (req, res) => {
    try {
        const { senderId, platform } = req.body;
        const existingConversation = await conversation_1.conversationModel
            .findOne({
            conversationType: "GROUP",
            participants: {
                $all: [{ $elemMatch: { user: senderId } }],
            },
        })
            .populate("participants.user", "fullName phone email role profileImage");
        console.log("step 2");
        if (existingConversation) {
            res.status(200).json({
                code: config_1.messages.SUCCESSFULLY.code,
                message: config_1.messages.SUCCESSFULLY.message,
                data: existingConversation,
            });
            return;
        }
        let senderType = conversation_1.UserType.ADMIN;
        const sender = await staff_1.staffModel.findById(senderId);
        if (!sender) {
            senderType = conversation_1.UserType.USER;
        }
        let role = ["SUPER_ADMIN", "TAXI_ADMIN", "TAXI_MANAGER", "TAXI_STAFF"];
        if (platform === "EXPRESS") {
            role = ["SUPER_ADMIN", "EXPRESS_ADMIN", "EXPRESS_MANAGER", "EXPRESS_STAFF"];
        }
        const allStaff = await staff_1.staffModel.find({ role: { $in: role } }, "_id").lean();
        console.log("senderType======>", senderType);
        const participants = [
            { user: senderId, joinDate: Date.now(), userType: senderType },
            ...allStaff.map((staff) => ({
                user: staff._id,
                joinDate: Date.now(),
                userType: conversation_1.UserType.ADMIN,
            })),
        ];
        const newConversation = await conversation_1.conversationModel.create({
            participants,
            conversationType: "GROUP",
            conversationName: "SUPPORT_GROUP",
            latestMessageData: {
                isDeleted: false,
            },
        });
        const fullConversation = await conversation_1.conversationModel
            .findOne({
            _id: newConversation._id,
        })
            .populate("participants.user", "fullName phone email role profileImage isOnline");
        res.status(201).json({
            code: config_1.messages.CREATE_SUCCESSFUL.code,
            message: config_1.messages.CREATE_SUCCESSFUL.message,
            data: fullConversation,
        });
        return;
    }
    catch (error) {
        console.log(error);
        res.status(500).json(config_1.messages.INTERNAL_SERVER_ERROR);
        return;
    }
};
exports.createGroupConversation = createGroupConversation;
const getConversation = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            res.status(400).json(config_1.messages.BAD_REQUEST);
            return;
        }
        console.log("Registered models:", mongoose_1.default.modelNames());
        const conversation = await conversation_1.conversationModel
            .findOne({
            _id: id,
        })
            .populate("participants.user", "fullName phone email role profileImage");
        if (!conversation) {
            res.status(404).json(config_1.messages.CONVERSATION_NOT_FOUND);
            return;
        }
        res.status(200).json({
            code: config_1.messages.SUCCESSFULLY.code,
            message: config_1.messages.SUCCESSFULLY.message,
            data: conversation,
        });
        return;
    }
    catch (error) {
        console.log("error====>", error);
        res.status(500).json(config_1.messages.INTERNAL_SERVER_ERROR);
        return;
    }
};
exports.getConversation = getConversation;
const getAllConversions = async (req, res) => {
    try {
        const { search, skip = "0", limit = "100" } = req.query;
        const userId = req.user.userId;
        console.log("data   ===> ", req.user);
        const skipNumber = parseInt(skip, 10);
        const limitNumber = parseInt(limit, 10);
        const query = {
            "participants.user": new mongoose_1.Types.ObjectId(userId),
        };
        if (search) {
            const userSearchResults = await user_1.userModel
                .find({
                $or: [{ fullName: { $regex: search, $options: "i" } }, { nickname: { $regex: search, $options: "i" } }],
            }, { _id: 1 })
                .lean();
            query.$or = [
                {
                    conversationType: "GROUP",
                    conversationName: { $regex: search, $options: "i" },
                },
                {
                    "participants.user": {
                        $in: userSearchResults.map((user) => user._id),
                    },
                },
            ];
        }
        console.log("query  ===> ", query);
        const conversations = await conversation_1.conversationModel
            .find(query)
            .populate("participants.user", "fullName phone email role profileImage isOnline")
            .sort({ updatedAt: -1 })
            .lean();
        const messageIds = conversations
            .map((c) => c.latestMessageData?.messageId)
            .filter((id) => id != null);
        console.log("messageIds  ===> ", messageIds);
        const messageStatuses = await messageStatus_1.messageStatusModel
            .find({
            message: { $in: messageIds },
            user: new mongoose_1.Types.ObjectId(userId),
        })
            .select("message status")
            .lean();
        console.log("messageStatuses  ===> ", messageStatuses);
        const statusMap = new Map();
        messageStatuses.forEach((status) => {
            statusMap.set(status.message.toString(), status.status === "READ");
        });
        console.log("statusMap  ===> ", statusMap);
        const conversationData = conversations.map((conversation) => {
            if (conversation.latestMessageData?.messageId) {
                conversation.latestMessageData = {
                    ...conversation.latestMessageData,
                    isRead: statusMap.get(conversation.latestMessageData.messageId.toString()) || false,
                };
            }
            return conversation;
        });
        conversationData.sort((a, b) => {
            return b.updatedAt.getTime() - a.updatedAt.getTime();
        });
        const paginatedResults = conversationData.slice(skipNumber, skipNumber + limitNumber);
        res.status(200).json({
            code: config_1.messages.SUCCESSFULLY.code,
            message: config_1.messages.SUCCESSFULLY.message,
            data: paginatedResults,
        });
    }
    catch (error) {
        res.status(500).json(config_1.messages.INTERNAL_SERVER_ERROR);
    }
};
exports.getAllConversions = getAllConversions;
//# sourceMappingURL=index.js.map