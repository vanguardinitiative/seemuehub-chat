import { IConversation } from "../../models/conversation";
import { IMessage } from "../../models/message";
import mongoose from "mongoose";
export declare const createOrGetConversation: (senderId: string, receiverId: string, session: mongoose.ClientSession) => Promise<mongoose.Document<unknown, {}, IConversation, {}> & IConversation & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}>;
export declare const messageNotification: (conversationData: IConversation, messageData: IMessage) => Promise<void>;
//# sourceMappingURL=helper.d.ts.map