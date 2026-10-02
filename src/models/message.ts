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

/**
 * What a reply shows of the message it answers (CHAT-CONTRACT.md §2.1). Built
 * by the service from the stored target when the reply is sent (see
 * utils/reply.ts), never taken from a client, so it stays as it was even if
 * the target is later deleted.
 */
export interface IReplyPreview {
  messageId: mongoose.Types.ObjectId;
  senderId: string;
  messageType: string;
  /** TEXT: the content, clipped to 160 characters. Every other type: "". */
  text: string;
  /** FILE: the attachment's originalName, or its fileName. */
  fileName?: string;
  /** IMAGE: the attachment's fileUrl. STICKER: the sticker's url. */
  thumbUrl?: string;
}

/** What an AGENT message is about (AGENT-CONTRACT.md §8.1). */
export const AGENT_MESSAGE_KINDS = ["AGREEMENT", "CHECKLIST", "NOTE"] as const;
export type AgentMessageKind = (typeof AGENT_MESSAGE_KINDS)[number];

/**
 * The Seemue AI card an AGENT message carries (AGENT-CONTRACT.md §8.1). Only
 * POST /agent-messages writes it (src/services/agent-messages.ts), from
 * seemuehub-backend; no client can set it (RESERVED_MESSAGE_FIELDS).
 */
export interface IAgentMessage {
  v: 1;
  kind: AgentMessageKind;
  /** A §4 card: `{ type, v, id, fallbackText, ... }`, checked by utils/agent-message.ts. */
  card: Record<string, unknown>;
  /** The Seemue AI thread it came from, when there is one. */
  threadId?: string;
  /** The AgentAction it belongs to, when there is one. */
  actionId?: string;
  /** The participant (or company member) who asked for it; also the message's sender. */
  requestedBy: mongoose.Types.ObjectId;
}

/** One person's reaction (CHAT-CONTRACT.md §3.2): at most one per user per message. */
export interface IReaction {
  user: mongoose.Types.ObjectId;
  emoji: string;
  at: Date;
}

enum MessageType {
  TEXT = "TEXT",
  IMAGE = "IMAGE",
  VIDEO = "VIDEO",
  VOICE = "VOICE",
  FILE = "FILE",
  REACTION = "REACTION",
  STICKER = "STICKER",
  LOCATION = "LOCATION",
  VOICE_CALL = "VOICE_CALL",
  VIDEO_CALL = "VIDEO_CALL",
  SYSTEM = "SYSTEM",
  // A Seemue AI card posted on a participant's request (AGENT-CONTRACT.md §8).
  // Server-only, like SYSTEM: utils/message-type.ts keeps it out of what
  // clients may send.
  AGENT = "AGENT",
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
  replyPreview?: IReplyPreview;
  reactions?: IReaction[];
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
  sendAsOrganizationId?: mongoose.Types.ObjectId;
  actorUserId?: mongoose.Types.ObjectId;
  /** AGENT messages only. */
  agent?: IAgentMessage;
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
    // Both absent unless set, so a message without them is stored as before.
    // No length validators: a failed validation would fail the send, so the
    // limits are applied where the preview is built (utils/reply.ts).
    replyPreview: {
      type: new Schema(
        {
          messageId: { type: Schema.Types.ObjectId, ref: "Message" },
          senderId: String,
          messageType: String,
          text: String,
          fileName: String,
          thumbUrl: String,
        },
        { _id: false }
      ),
      default: undefined,
    },
    // Written only by REACT_MESSAGE's pipeline update (services/reactions.ts).
    reactions: {
      type: [
        new Schema(
          {
            user: { type: Schema.Types.ObjectId, ref: "User" },
            emoji: String,
            at: Date,
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
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
    sendAsOrganizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User" },
    // AGENT messages only; absent on every other message. The card's shape is
    // checked before the write (utils/agent-message.ts), so no validators
    // here could fail a send that already passed.
    agent: {
      type: new Schema(
        {
          v: Number,
          kind: { type: String, enum: AGENT_MESSAGE_KINDS },
          card: Schema.Types.Mixed,
          threadId: String,
          actionId: String,
          requestedBy: { type: Schema.Types.ObjectId, ref: "User" },
        },
        { _id: false, minimize: false }
      ),
      default: undefined,
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
