"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isParticipant = exports.userIdOf = exports.participantOf = void 0;
const mongoose_1 = require("mongoose");
const conversation_1 = require("../models/conversation");
const participantOf = (userId) => ({
    "participants.user": new mongoose_1.Types.ObjectId(userId),
});
exports.participantOf = participantOf;
const userIdOf = (req) => {
    const id = req.user?.userId;
    return typeof id === "string" && mongoose_1.Types.ObjectId.isValid(id) ? id : null;
};
exports.userIdOf = userIdOf;
const isParticipant = async (conversationId, userId) => Boolean(await conversation_1.conversationModel
    .findOne({ _id: conversationId, ...(0, exports.participantOf)(userId) })
    .select("_id")
    .lean());
exports.isParticipant = isParticipant;
//# sourceMappingURL=conversation-access.js.map