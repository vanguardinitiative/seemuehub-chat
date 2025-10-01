import mongoose, { Document, Schema } from "mongoose";

enum ConversationType {
  PRIVATE = "PRIVATE",
  GROUP = "GROUP",
  ANONYMOUS = "ANONYMOUS",
}

export enum UserType {
  USER = "USER",
  ADMIN = "ADMIN",
}

export enum OrderStatus {
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

export interface IParticipant {
  user: mongoose.Types.ObjectId;
  userType: UserType;
  joinDate: Date;
  isMuted: boolean;
}

interface ILatestMessageData {
  senderId?: string;
  messageId?: string;
  deliveredAllAt?: Date;
  readAllAt?: Date;
  content?: string;
  sendAt?: Date;
  isDeleted: boolean;
}

export interface IConversation extends Document {
  _id: mongoose.Types.ObjectId;
  orderId?: mongoose.Types.ObjectId; // Reference to Order model
  conversationName?: string;
  conversationImage?: string;
  conversationType: ConversationType;
  participants: IParticipant[];
  latestMessageData: ILatestMessageData;
  background?: string;
  // Order integration fields
  orderStatus?: string; // Current order status
  orderTitle?: string; // Order title for display
  orderBudget?: {
    amount: number;
    currency: string;
  };
  orderDeadline?: Date; // Order deadline
  isOrderActive?: boolean; // Whether the order is still active
  orderPriority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
}

const conversationSchema = new Schema<IConversation>(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      index: true,
    },
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
          type: Schema.Types.ObjectId,
          ref: "User",
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
    // Order integration fields
    orderStatus: {
      type: String,
      enum: Object.values(OrderStatus),
      index: true,
    },
    orderTitle: String,
    orderBudget: {
      amount: { type: Number, min: 0 },
      currency: { type: String, default: "THB" },
    },
    orderDeadline: Date,
    isOrderActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    orderPriority: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "URGENT"],
      default: "MEDIUM",
    },
  },
  { timestamps: true }
);

// ✅ Compound Index for Fast Querying Conversations with Users
conversationSchema.index({ "participants.user": 1, conversationType: 1 });

// ✅ Index for Sorting Conversations by Last Update
conversationSchema.index({ updatedAt: -1 });

// ✅ Order-related indexes
conversationSchema.index({ orderId: 1, isOrderActive: 1 });
conversationSchema.index({ orderStatus: 1, isOrderActive: 1 });
conversationSchema.index({ orderPriority: 1, orderDeadline: 1 });
conversationSchema.index({ "participants.user": 1, orderId: 1 });

export { ConversationType };
export const conversationModel = mongoose.model<IConversation>("Conversation", conversationSchema);
