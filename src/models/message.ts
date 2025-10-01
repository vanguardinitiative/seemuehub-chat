import mongoose, { Document, Schema } from "mongoose";

enum OrderStatus {
  PENDING = "PENDING",
  ACCEPTED = "ACCEPTED",
  IN_PROGRESS = "IN_PROGRESS",
  IN_REVIEW = "IN_REVIEW",
  REVISION_REQUESTED = "REVISION_REQUESTED",
  DELIVERED = "DELIVERED",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
  REFUNDED = "REFUNDED",
  DISPUTED = "DISPUTED",
}

interface ILocation {
  lng: number;
  lat: number;
}

interface IAttachment {
  fileName: string;
  fileUrl: string;
  fileSize: string;
  originalName: string;
}

enum MessageType {
  TEXT = "TEXT",
  IMAGE = "IMAGE",
  VIDEO = "VIDEO",
  REACTION = "REACTION",
  VOICE = "VOICE",
  FILE = "FILE",
  STICKER = "STICKER",
  LOCATION = "LOCATION",
  VOICE_CALL = "VOICE_CALL",
  VIDEO_CALL = "VIDEO_CALL",
  SYSTEM = "SYSTEM",
  // Order-related message types
  ORDER_UPDATE = "ORDER_UPDATE",
  ORDER_STATUS_CHANGE = "ORDER_STATUS_CHANGE",
  ORDER_DELIVERY = "ORDER_DELIVERY",
  ORDER_REVISION = "ORDER_REVISION",
  ORDER_PAYMENT = "ORDER_PAYMENT",
  ORDER_DISPUTE = "ORDER_DISPUTE",
}

enum CallStatus {
  RINGING = "RINGING",
  MISSED = "MISSED",
  ACCEPTED = "ACCEPTED",
  REJECTED = "REJECTED",
  CANCELLED = "CANCELLED",
  ENDED = "ENDED",
}

export interface IMessage extends Document {
  _id: mongoose.Types.ObjectId;
  sender: mongoose.Types.ObjectId;
  conversation: mongoose.Types.ObjectId;
  messageType: MessageType;
  location?: ILocation;
  content?: string;
  attachments?: IAttachment[];
  call?: mongoose.Types.ObjectId;
  callStatus?: CallStatus;
  fileUploaded: boolean;
  callId?: string;
  startCallAt?: Date;
  endCallAt?: Date;
  callDuration?: string;
  isUpdated?: boolean;
  deletedAt?: Date;
  isDeleted: boolean;
  deletedBy?: mongoose.Types.ObjectId;
  sendAt: Date;
  isReply: boolean;
  replyTo?: mongoose.Types.ObjectId;
  deliveredAllAt?: Date;
  readAllAt?: Date;
  // Order-related fields
  orderId?: mongoose.Types.ObjectId; // Reference to Order
  orderStatus?: string; // Order status when message was sent
  orderAction?: {
    type: string; // e.g., "status_change", "delivery", "revision_request"
    fromStatus?: string;
    toStatus?: string;
    metadata?: any; // Additional data for the action
  };
  isOrderMessage?: boolean; // Whether this is an order-related message
}

const messageSchema = new Schema<IMessage>(
  {
    _id: { type: Schema.Types.ObjectId, required: true, default: () => new mongoose.Types.ObjectId() },
    sender: { type: Schema.Types.ObjectId, ref: "User" },
    conversation: { type: Schema.Types.ObjectId, ref: "Conversation", index: true },
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
    call: { type: Schema.Types.ObjectId, ref: "Call" },
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
    deletedBy: { type: Schema.Types.ObjectId, ref: "User" },
    sendAt: {
      type: Date,
      default: Date.now,
    },
    isReply: { type: Boolean, default: false },
    replyTo: { type: Schema.Types.ObjectId, ref: "Message" },
    deliveredAllAt: Date,
    readAllAt: Date,
    // Order-related fields
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      index: true,
    },
    orderStatus: {
      type: String,
      enum: Object.values(OrderStatus),
    },
    orderAction: {
      type: {
        type: String,
        enum: ["status_change", "delivery", "revision_request", "payment", "dispute"],
      },
      fromStatus: String,
      toStatus: String,
      metadata: Schema.Types.Mixed,
    },
    isOrderMessage: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

// Order-related indexes
messageSchema.index({ orderId: 1, isOrderMessage: 1 });
messageSchema.index({ conversation: 1, isOrderMessage: 1 });
messageSchema.index({ "orderAction.type": 1, sendAt: -1 });

export { MessageType, CallStatus };
export const messageModel = mongoose.model<IMessage>("Message", messageSchema);
