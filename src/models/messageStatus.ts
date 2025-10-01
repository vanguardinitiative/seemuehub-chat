import mongoose, { Schema, Document } from "mongoose";

enum MessageStatusType {
  READ = "READ",
  UNREAD = "UNREAD",
}

export interface IMessageStatus extends Document {
  conversation: mongoose.Types.ObjectId;
  message: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  deliveredAt?: Date;
  readAt?: Date;
  status: MessageStatusType;
}

const messageStatusSchema = new Schema<IMessageStatus>(
  {
    conversation: { type: Schema.Types.ObjectId, ref: "Conversation" },
    message: { type: Schema.Types.ObjectId, ref: "Message" },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    deliveredAt: Date,
    readAt: Date,
    status: {
      type: String,
      enum: Object.values(MessageStatusType),
      default: MessageStatusType.UNREAD,
    },
  },
  { timestamps: true }
);

// ✅ Compound Index for Fast Querying Conversations with Users
messageStatusSchema.index({ message: 1, user: 1 });

export { MessageStatusType };
export const messageStatusModel = mongoose.model<IMessageStatus>("MessageStatus", messageStatusSchema);
