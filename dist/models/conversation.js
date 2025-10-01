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
exports.conversationModel = exports.ConversationType = exports.UserType = void 0;
const mongoose_1 = __importStar(require("mongoose"));
var ConversationType;
(function (ConversationType) {
    ConversationType["PRIVATE"] = "PRIVATE";
    ConversationType["GROUP"] = "GROUP";
    ConversationType["ANONYMOUS"] = "ANONYMOUS";
})(ConversationType || (exports.ConversationType = ConversationType = {}));
var UserType;
(function (UserType) {
    UserType["USER"] = "User";
    UserType["STAFF"] = "Staff";
})(UserType || (exports.UserType = UserType = {}));
const conversationSchema = new mongoose_1.Schema({
    orderId: String,
    conversationName: String,
    conversationImage: String,
    conversationType: {
        type: String,
        enum: Object.values(ConversationType),
        default: ConversationType.PRIVATE,
        index: true,
    },
    participants: [
        {
            user: {
                type: mongoose_1.Schema.Types.ObjectId,
                refPath: "participants.userType",
                index: true,
            },
            userType: {
                type: String,
                enum: Object.values(UserType),
                default: UserType.USER,
            },
            joinDate: { type: Date, default: Date.now },
            isMuted: { type: Boolean, default: false },
        },
    ],
    latestMessageData: {
        senderId: String,
        messageId: String,
        deliveredAllAt: Date,
        readAllAt: Date,
        content: String,
        sendAt: {
            type: Date,
            default: Date.now,
        },
        isDeleted: { type: Boolean, default: false },
    },
    background: String,
}, { timestamps: true });
conversationSchema.index({ "participants.user": 1, conversationType: 1, platform: 1 });
conversationSchema.index({ updatedAt: -1 });
exports.conversationModel = mongoose_1.default.model("Conversation", conversationSchema);
//# sourceMappingURL=conversation.js.map