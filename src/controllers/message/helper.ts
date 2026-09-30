import { conversationModel, IConversation } from "@/models/conversation";
import { IMessage } from "@/models/message";
import { messageStatusModel } from "@/models/messageStatus";
import mongoose from "mongoose";

export const createOrGetConversation = async (
  senderId: string,
  receiverId: string,
  session: mongoose.ClientSession
) => {
  const conversation = await conversationModel
    .findOne({
      conversationType: "PRIVATE",
      $and: [{ "participants.user": senderId }, { "participants.user": receiverId }],
    })
    .session(session);

  if (conversation) return conversation;

  const chatData = {
    conversationName: "Private",
    conversationType: "PRIVATE",
    participants: [
      { user: senderId, joinDate: new Date() },
      { user: receiverId, joinDate: new Date() },
    ],
  };
  const [newConversation] = await conversationModel.create([chatData], { session });
  return newConversation;
};

/**
 * One UNREAD status per participant other than the sender, which
 * PUT /message-status/read turns into read receipts. Swallows its own errors:
 * the message is already stored.
 */
export const createMessageStatuses = async (conversationData: IConversation, messageData: IMessage) => {
  try {
    const senderId = messageData.sender.toString();
    const messageStatusData = conversationData.participants
      .filter((participant) => participant.user.toString() !== senderId)
      .map((participant) => ({
        message: messageData._id,
        user: participant.user,
        conversation: conversationData._id,
      }));
    await messageStatusModel.insertMany(messageStatusData);
  } catch (error) {
    console.error("Error recording message statuses:", error instanceof Error ? error.message : "Unknown error");
  }
};
