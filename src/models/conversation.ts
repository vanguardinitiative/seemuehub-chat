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
  Pending = "PENDING", // รอการยอมรับจาก freelancer
  Accepted = "ACCEPTED", // Freelancer ยอมรับงานแล้ว
  InProgress = "IN_PROGRESS", // กำลังดำเนินการ
  InReview = "IN_REVIEW", // กำลังตรวจสอบงาน
  RevisionRequested = "REVISION_REQUESTED", // ลูกค้าขอแก้ไขงาน
  Delivered = "DELIVERED", // ส่งมอบงานแล้ว
  Completed = "COMPLETED", // เสร็จสิ้น
  Cancelled = "CANCELLED", // ยกเลิก
  Refunded = "REFUNDED", // คืนเงิน
  Disputed = "DISPUTED", // มีข้อพิพาท
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
  /**
   * When this participant last read the conversation (CHAT-CONTRACT.md §1.1):
   * everything sent at or before it counts as read by them. Written only by
   * PUT /message-status/read (a $max, so it never moves back) and by
   * scripts/backfill-read-state.ts. Absent until the first read.
   */
  lastReadAt?: Date;
  /**
   * Up to when this participant's devices have received the conversation
   * (CHAT-CONTRACT.md §5.1): the socket's DELIVERED, the list and messages
   * GETs, and the read PUT move it, always with $max and timestamps off.
   * Absent until the first delivery.
   */
  lastDeliveredAt?: Date;
}

interface ILatestMessageData {
  senderId?: string;
  messageId?: string;
  deliveredAllAt?: Date;
  readAllAt?: Date;
  content?: string;
  sendAt?: Date;
  isDeleted: boolean;
  /**
   * The order step the backend last posted (SUBMITTED_PROPOSAL, PAYMENT_SUCCESS,
   * ACCEPTED_ORDER, AUTO_APPROVED, DISPUTE_OPENED, …), not an order status.
   */
  orderStep?: string;
  /**
   * The latest message's type, so the list can say "Sticker" or "Photo"
   * instead of showing its content. Rows written before this field existed,
   * and the ones seemuehub-backend writes itself, have none.
   */
  messageType?: string;
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
  orderTitle?: string; // Order title for display (the package name)
  workTitle?: string; // The gig's or job's title, set by the backend
  orderBudget?: {
    amount: number;
    currency: string;
  };
  orderDeadline?: Date; // Order deadline
  isOrderActive?: boolean; // Whether the order is still active
  orderPriority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  orderSender?: string;
  organizationId?: mongoose.Types.ObjectId;
  applicationId?: mongoose.Types.ObjectId;
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
        // No default and no index: absent means "never read here". It has to
        // be in the schema, or mongoose strips the read PUT's update.
        lastReadAt: Date,
        // The same for "never delivered here" (CHAT-CONTRACT.md §5.1).
        lastDeliveredAt: Date,
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
      // A step name, not an order status: the backend adds steps over time, and
      // an enum here would reject them on any validated write.
      orderStep: String,
      // Not an enum, for the same reason: this is a copy of the message's
      // type, and the message model is where the type is validated.
      messageType: String,
    },
    background: String,
    // Order integration fields
    orderStatus: {
      type: String,
      enum: Object.values(OrderStatus),
      index: true,
    },
    orderTitle: String,
    workTitle: String,
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
    orderSender: String,
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
    applicationId: { type: Schema.Types.ObjectId, ref: "OrganizationApplication", index: true },
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
conversationSchema.index({ organizationId: 1, updatedAt: -1 });

export { ConversationType };
export const conversationModel = mongoose.model<IConversation>("Conversation", conversationSchema);
