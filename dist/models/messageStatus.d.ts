import mongoose, { Document } from "mongoose";
declare enum MessageStatusType {
    READ = "READ",
    UNREAD = "UNREAD"
}
export interface IMessageStatus extends Document {
    conversation: mongoose.Types.ObjectId;
    message: mongoose.Types.ObjectId;
    user: mongoose.Types.ObjectId;
    deliveredAt?: Date;
    readAt?: Date;
    status: MessageStatusType;
}
export { MessageStatusType };
export declare const messageStatusModel: mongoose.Model<IMessageStatus, {}, {}, {}, mongoose.Document<unknown, {}, IMessageStatus, {}> & IMessageStatus & Required<{
    _id: unknown;
}> & {
    __v: number;
}, any>;
//# sourceMappingURL=messageStatus.d.ts.map