import mongoose, { Document } from "mongoose";
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
declare enum MessageType {
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
    ORDER_UPDATE = "ORDER_UPDATE",
    ORDER_STATUS_CHANGE = "ORDER_STATUS_CHANGE",
    ORDER_DELIVERY = "ORDER_DELIVERY",
    ORDER_REVISION = "ORDER_REVISION",
    ORDER_PAYMENT = "ORDER_PAYMENT",
    ORDER_DISPUTE = "ORDER_DISPUTE"
}
declare enum CallStatus {
    RINGING = "RINGING",
    MISSED = "MISSED",
    ACCEPTED = "ACCEPTED",
    REJECTED = "REJECTED",
    CANCELLED = "CANCELLED",
    ENDED = "ENDED"
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
    orderId?: mongoose.Types.ObjectId;
    orderStatus?: string;
    orderAction?: {
        type: string;
        fromStatus?: string;
        toStatus?: string;
        metadata?: any;
    };
    isOrderMessage?: boolean;
}
export { MessageType, CallStatus };
export declare const messageModel: mongoose.Model<IMessage, {}, {}, {}, mongoose.Document<unknown, {}, IMessage, {}> & IMessage & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
//# sourceMappingURL=message.d.ts.map