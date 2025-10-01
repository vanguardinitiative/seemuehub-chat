import { messages } from "./../../config/index";
import { conversationModel, IConversation, IParticipant, UserType } from "@/models/conversation";
import { IMessage } from "@/models/message";
import { messageStatusModel } from "@/models/messageStatus";
import { IUser, userModel } from "@/models/user";
import { Schema } from "inspector/promises";
import axios from "axios";
import mongoose from "mongoose";
import { staffModel } from "@/models/staff";

interface INotificationPayload {
  conversationId: string;
  title: string;
  detail: string;
  imageProfile: string;
  name: string;
  conversationType: string;
  messageId: string;
  imageUrl?: string;
  userChatIds: string[];
  recipient: string;
  type: string;
  platform: string;
  recipientRole: string;
}
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

export const messageNotification = async (conversationData: IConversation, messageData: IMessage) => {
  try {
    const senderId = messageData.sender.toString();
    console.log("senderId", senderId);

    const messageStatusData = conversationData.participants
      .map((participant) => {
        if (participant.user.toString() !== senderId) {
          return {
            message: messageData._id,
            user: participant.user,
            conversation: conversationData._id,
          };
        }
        return null;
      })
      .filter(Boolean);
    await messageStatusModel.insertMany(messageStatusData);

    // Get users who should receive notifications (excluding sender & muted users)
    const userChatIds =
      conversationData?.participants
        ?.filter(
          (participant) =>
            participant.user.toString() !== senderId && !participant.isMuted && participant.userType === UserType.USER
        )
        ?.map((participant) => participant.user.toString()) || [];
    const isPrivateChat = conversationData?.conversationType === "PRIVATE";

    let senderName = conversationData?.conversationName;
    let senderProfile = conversationData?.conversationImage;
    if (isPrivateChat) {
      const messageDetail = await userModel.findById(senderId);
      senderName = messageDetail?.userName;
      senderProfile = messageDetail?.profileImage;
    } else {
      const messageDetail = await staffModel.findById(senderId);
      senderName = messageDetail?.fullName;
      senderProfile = messageDetail?.profileImage;
    }
    const conversationTitle = isPrivateChat ? senderName : "ສູນຊ່ວຍເຫຼືອ";
    const conversationImage = isPrivateChat ? senderProfile : conversationData?.conversationImage;
    let detailPrefix = isPrivateChat ? "" : `${senderName}: `;

    // Determine message type content
    const messageContentMap: Record<string, string> = {
      TEXT: messageData.content || "",
      IMAGE: "📷 Sent a photo.",
      VIDEO: "🎦 Sent a video.",
      VOICE: "🎧 Sent a voice message.",
      FILE: "📄 Sent a file.",
      LOCATION: "📍 Sent a location.",
    };
    const content = messageContentMap[messageData.messageType || ""] || "Sent a message.";

    // Function to send notifications
    const sendNotificationToUsers = (userIds: string[], isTagged = false): void => {
      if (userIds.length === 0) return;
      const payload: INotificationPayload = {
        conversationId: conversationData._id?.toString() ?? "",
        title: conversationTitle || "",
        detail: `${detailPrefix}${isTagged ? `📣 ${content}` : content}`,
        imageProfile: conversationImage || "",
        name: conversationTitle || "",
        conversationType: conversationData.conversationType,
        messageId: messageData._id.toString(),
        imageUrl: messageData.attachments?.[0]?.fileUrl,
        userChatIds: userIds,
        recipient: userIds[0],
        type: "CHAT",
        platform: "TAXI",
        recipientRole: "CUSTOMER",
      };
      sendNotification(payload);
    };

    sendNotificationToUsers(userChatIds);
  } catch (error) {
    console.error("Error sending notification:");
  }
};

const sendNotification = async (messageData: INotificationPayload) => {
  try {
    console.log("step8");
    console.log("messageData", messageData);
    console.log("process.env.NOTIFICATION_URL===>", process.env.NOTIFICATION_URL);
    await axios.post(process.env.NOTIFICATION_URL || "localhost", messageData, {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error sending notification:");
  }
};
