import mongoose, { Document } from "mongoose";
declare enum ConversationType {
    PRIVATE = "PRIVATE",
    GROUP = "GROUP",
    ANONYMOUS = "ANONYMOUS"
}
export declare enum UserType {
    USER = "User",
    STAFF = "Staff"
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
    orderId?: string;
    conversationName?: string;
    conversationImage?: string;
    conversationType: ConversationType;
    participants: IParticipant[];
    latestMessageData: ILatestMessageData;
    background?: string;
}
export { ConversationType };
export declare const conversationModel: mongoose.Model<IConversation, {}, {}, {}, mongoose.Document<unknown, {}, IConversation, {}> & IConversation & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
//# sourceMappingURL=conversation.d.ts.map