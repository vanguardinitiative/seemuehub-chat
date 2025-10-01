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
exports.messageModel = exports.CallStatus = exports.MessageType = void 0;
const mongoose_1 = __importStar(require("mongoose"));
var MessageType;
(function (MessageType) {
    MessageType["TEXT"] = "TEXT";
    MessageType["IMAGE"] = "IMAGE";
    MessageType["VIDEO"] = "VIDEO";
    MessageType["REACTION"] = "REACTION";
    MessageType["VOICE"] = "VOICE";
    MessageType["FILE"] = "FILE";
    MessageType["STICKER"] = "STICKER";
    MessageType["LOCATION"] = "LOCATION";
    MessageType["VOICE_CALL"] = "VOICE_CALL";
    MessageType["VIDEO_CALL"] = "VIDEO_CALL";
    MessageType["SYSTEM"] = "SYSTEM";
})(MessageType || (exports.MessageType = MessageType = {}));
var CallStatus;
(function (CallStatus) {
    CallStatus["RINGING"] = "RINGING";
    CallStatus["MISSED"] = "MISSED";
    CallStatus["ACCEPTED"] = "ACCEPTED";
    CallStatus["REJECTED"] = "REJECTED";
    CallStatus["CANCELLED"] = "CANCELLED";
    CallStatus["ENDED"] = "ENDED";
})(CallStatus || (exports.CallStatus = CallStatus = {}));
const messageSchema = new mongoose_1.Schema({
    _id: { type: mongoose_1.Schema.Types.ObjectId, required: true, default: () => new mongoose_1.default.Types.ObjectId() },
    sender: { type: mongoose_1.Schema.Types.ObjectId, ref: "User" },
    conversation: { type: mongoose_1.Schema.Types.ObjectId, ref: "Conversation", index: true },
    messageType: {
        type: String,
        enum: Object.values(MessageType),
        default: MessageType.TEXT,
    },
    location: {
        lng: Number,
        lat: Number,
    },
    content: String,
    attachments: [
        {
            fileName: String,
            fileUrl: String,
            fileSize: String,
            originalName: String,
        },
    ],
    call: { type: mongoose_1.Schema.Types.ObjectId, ref: "Call" },
    callStatus: {
        type: String,
        enum: Object.values(CallStatus),
    },
    fileUploaded: {
        type: Boolean,
        default: false,
    },
    callId: String,
    startCallAt: Date,
    endCallAt: Date,
    callDuration: String,
    isUpdated: Boolean,
    deletedAt: Date,
    isDeleted: { type: Boolean, default: false },
    deletedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: "User" },
    sendAt: {
        type: Date,
        default: Date.now,
    },
    isReply: { type: Boolean, default: false },
    replyTo: { type: mongoose_1.Schema.Types.ObjectId, ref: "Message" },
    deliveredAllAt: Date,
    readAllAt: Date,
}, { timestamps: true });
exports.messageModel = mongoose_1.default.model("Message", messageSchema);
//# sourceMappingURL=message.js.map