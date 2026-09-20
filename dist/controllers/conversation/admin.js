"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAllConversationsAdmin = void 0;
const config_1 = require("../../config/index.js");
const conversation_1 = require("../../models/conversation.js");
const user_1 = require("../../models/user.js");
const getAllConversationsAdmin = async (req, res) => {
    try {
        const { search, skip = "0", limit = "50", orderStatus } = req.query;
        const skipNumber = Number.parseInt(skip, 10) || 0;
        const limitNumber = Math.min(Number.parseInt(limit, 10) || 50, 100);
        const query = {};
        if (orderStatus) {
            query.orderStatus = orderStatus;
        }
        if (search?.trim()) {
            const term = { $regex: search.trim(), $options: "i" };
            const matchedUsers = await user_1.userModel
                .find({ $or: [{ displayName: term }, { userName: term }, { email: term }] }, { _id: 1 })
                .lean();
            query.$or = [
                { conversationName: term },
                { orderTitle: term },
                { "participants.user": { $in: matchedUsers.map((user) => user._id) } },
            ];
        }
        const [conversations, total] = await Promise.all([
            conversation_1.conversationModel
                .find(query)
                .populate("participants.user", "userName displayName email profileImage isFreelancer")
                .sort({ updatedAt: -1 })
                .skip(skipNumber)
                .limit(limitNumber)
                .lean(),
            conversation_1.conversationModel.countDocuments(query),
        ]);
        res.status(200).json({
            code: config_1.messages.SUCCESSFULLY.code,
            message: config_1.messages.SUCCESSFULLY.message,
            data: {
                conversations,
                pagination: {
                    skip: skipNumber,
                    limit: limitNumber,
                    total,
                },
            },
        });
    }
    catch (error) {
        res.status(500).json(config_1.messages.INTERNAL_SERVER_ERROR);
    }
};
exports.getAllConversationsAdmin = getAllConversationsAdmin;
//# sourceMappingURL=admin.js.map