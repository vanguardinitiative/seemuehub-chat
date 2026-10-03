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
  // Company ↔ candidate conversations (worktrees/ORG-CHAT-CONTRACT.md §3.1).
  // All absent on every other conversation. The organization's members are
  // never participants: `participants` holds the candidate alone.
  /** The one USER participant. Absent on organization conversations opened before this field. */
  candidateUserId?: mongoose.Types.ObjectId;
  /** The organization as it was at the open, refreshed on every company message. */
  organization?: IOrganizationSnapshot;
  /** The company side's read state; members are not participants, so it cannot live in participants[]. */
  orgSide?: { lastReadAt?: Date; lastReadBy?: mongoose.Types.ObjectId; lastDeliveredAt?: Date };
  /** Why the company could open it, as the backend proved. */
  basis?: OrgChatBasis;
  /** The job the basis points at, when there is one. */
  jobId?: mongoose.Types.ObjectId;
  /** The member who opened it. */
  openedBy?: mongoose.Types.ObjectId;
  /** When the candidate blocked the company. Permanent. */
  candidateBlockedAt?: Date;
}

export const ORG_CHAT_BASES = ["UNLOCK", "APPLICATION", "MUTUAL_MATCH"] as const;
export type OrgChatBasis = (typeof ORG_CHAT_BASES)[number];

export interface IOrganizationSnapshot {
  name?: string;
  nameLao?: string;
  logo?: string;
  slug?: string;
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
    // Company ↔ candidate (see IConversation). No defaults, so every other
    // conversation is stored exactly as before; no indexes but the pair below.
    candidateUserId: { type: Schema.Types.ObjectId, ref: "User" },
    organization: {
      type: new Schema({ name: String, nameLao: String, logo: String, slug: String }, { _id: false }),
      default: undefined,
    },
    orgSide: {
      type: new Schema(
        { lastReadAt: Date, lastReadBy: { type: Schema.Types.ObjectId, ref: "User" }, lastDeliveredAt: Date },
        { _id: false }
      ),
      default: undefined,
    },
    basis: { type: String, enum: ORG_CHAT_BASES },
    jobId: { type: Schema.Types.ObjectId, ref: "Job" },
    openedBy: { type: Schema.Types.ObjectId, ref: "User" },
    candidateBlockedAt: Date,
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
// One conversation per organization and candidate (ORG-CHAT-CONTRACT.md §3.1).
// Partial, so only conversations that have a candidateUserId take part: the
// ones opened before it existed, keyed by applicationId, may still repeat a
// pair. Built by this service at start (autoIndex), and listed in
// seemuehub-backend's chat-owned-indexes.ts so its index sync never drops it.
conversationSchema.index(
  { organizationId: 1, candidateUserId: 1 },
  { unique: true, partialFilterExpression: { candidateUserId: { $exists: true } } }
);

export { ConversationType };
export const conversationModel = mongoose.model<IConversation>("Conversation", conversationSchema);
