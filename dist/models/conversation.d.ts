import mongoose, { Document } from "mongoose";
declare enum ConversationType {
    PRIVATE = "PRIVATE",
    GROUP = "GROUP",
    ANONYMOUS = "ANONYMOUS"
}
export declare enum UserType {
    USER = "USER",
    ADMIN = "ADMIN"
}
export declare enum OrderStatus {
    Pending = "PENDING",
    Accepted = "ACCEPTED",
    InProgress = "IN_PROGRESS",
    InReview = "IN_REVIEW",
    RevisionRequested = "REVISION_REQUESTED",
    Delivered = "DELIVERED",
    Completed = "COMPLETED",
    Cancelled = "CANCELLED",
    Refunded = "REFUNDED",
    Disputed = "DISPUTED"
}
export declare enum OrderStatus {
    PENDING = "PENDING",
    ACCEPTED = "ACCEPTED",
    IN_PROGRESS = "IN_PROGRESS",
    IN_REVIEW = "IN_REVIEW",
    REVISION_REQUESTED = "REVISION_REQUESTED",
    DELIVERED = "DELIVERED",
    COMPLETED = "COMPLETED",
    CANCELLED = "CANCELLED",
    REFUNDED = "REFUNDED",
    DISPUTED = "DISPUTED"
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
    orderStep?: OrderStatus;
}
export interface IConversation extends Document {
    _id: mongoose.Types.ObjectId;
    orderId?: mongoose.Types.ObjectId;
    conversationName?: string;
    conversationImage?: string;
    conversationType: ConversationType;
    participants: IParticipant[];
    latestMessageData: ILatestMessageData;
    background?: string;
    orderStatus?: string;
    orderTitle?: string;
    orderBudget?: {
        amount: number;
        currency: string;
    };
    orderDeadline?: Date;
    isOrderActive?: boolean;
    orderPriority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    orderSender?: string;
}
export { ConversationType };
export declare const conversationModel: mongoose.Model<IConversation, {}, {}, {}, mongoose.Document<unknown, {}, IConversation, {}> & IConversation & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
//# sourceMappingURL=conversation.d.ts.map