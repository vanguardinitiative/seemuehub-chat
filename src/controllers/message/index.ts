import mongoose from "mongoose";
import { Socket, Server } from "socket.io";
import { conversationModel, IParticipant } from "@/models/conversation";
import type { Request, Response } from "express";
import { messageModel, MessageType } from "@/models/message";
import { pub } from "@/config/redis";
import { createOrGetConversation, messageNotification } from "./helper";
import { messages } from "@/config";
import { messageStatusModel } from "@/models/messageStatus";

interface MessageData {
  messageType: string;
  content: string;
  conversationId?: string;
  senderId: string;
  receiverId: string;
  _id?: string;
}

const sendPrivateMessage = async (socket: Socket, io: Server, data: MessageData): Promise<void> => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    if (data._id && !mongoose.Types.ObjectId.isValid(data._id)) {
      throw new Error("Invalid _id format");
    }

    if (!data.messageType || !data.content || !data.senderId || !data.receiverId) {
      throw new Error("messageType, content, senderId, and receiverId are required");
    }

    const conversation = !data.conversationId
      ? await createOrGetConversation(data.senderId, data.receiverId, session)
      : null;

    const newConversationId = conversation?._id || data.conversationId;
    const customId = data._id ? new mongoose.Types.ObjectId(data._id) : new mongoose.Types.ObjectId();

    const [messageData] = await messageModel.create(
      [
        {
          ...data,
          _id: customId,
          messageType: data.messageType,
          // fileUploaded: data.messageType === MessageType.IMAGE ? false : true,
          fileUploaded: true,
          sender: data.senderId,
          content: data.content,
          conversation: newConversationId,
          sendAt: new Date(),
          createdAt: new Date(),
        },
      ],
      { session }
    );

    const conversationData = await conversationModel.findByIdAndUpdate(
      newConversationId,
      {
        latestMessageData: {
          senderId: data.senderId,
          messageId: messageData._id,
          content: data.content,
          readAllAt: null,
          sendAt: new Date(),
          deliveredAllAt: new Date(),
        },
      },
      { new: true, session }
    );
    // const messageStatusData = conversationData?.participants
    //   .map((participant: IParticipant) => {
    //     if (participant.user.toString() !== data.senderId) {
    //       return {
    //         message: messageData._id,
    //         user: participant.user,
    //         conversation: conversationData?._id,
    //       };
    //     }
    //     return null;
    //   })
    //   .filter(Boolean);
    // await messageStatusModel.insertMany(messageStatusData, { session });/

    console.log("conversationData", conversationData);
    pub.publish(
      "SEND_MESSAGE",
      JSON.stringify({
        conversation: conversationData,
        messageData,
      })
    );

    if (conversationData) {
      messageNotification(conversationData, messageData);
    }

    // if (data.messageType !== MessageType.IMAGE) {
    //   pub.publish(
    //     "SEND_MESSAGE",
    //     JSON.stringify({
    //       conversation: conversationData,
    //       messageData,
    //     })
    //   );
    // }

    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    console.error("Error sending message:", error instanceof Error ? error.message : "Unknown error");
    socket.emit("ERROR", { message: error instanceof Error ? error.message : "Unknown error" });
  } finally {
    session.endSession();
  }
};
const sendGroupMessage = async (socket: Socket, io: Server, data: MessageData): Promise<void> => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    if (data._id && !mongoose.Types.ObjectId.isValid(data._id)) {
      throw new Error("Invalid _id format");
    }

    if (!data.messageType || !data.content || !data.senderId || !data.conversationId) {
      throw new Error("messageType, content, senderId, and receiverId are required");
    }
    const newConversationId = data.conversationId;
    const customId = data._id ? new mongoose.Types.ObjectId(data._id) : new mongoose.Types.ObjectId();

    const [messageData] = await messageModel.create(
      [
        {
          ...data,
          _id: customId,
          messageType: data.messageType,
          // fileUploaded: data.messageType === MessageType.IMAGE ? false : true,
          fileUploaded: true,
          sender: data.senderId,
          content: data.content,
          conversation: newConversationId,
          sendAt: new Date(),
          createdAt: new Date(),
        },
      ],
      { session }
    );

    const conversationData = await conversationModel.findByIdAndUpdate(
      newConversationId,
      {
        latestMessageData: {
          senderId: data.senderId,
          messageId: messageData._id,
          content: data.content,
          readAllAt: null,
          sendAt: new Date(),
          deliveredAllAt: new Date(),
        },
      },
      { new: true, session }
    );
    pub.publish(
      "SEND_MESSAGE",
      JSON.stringify({
        conversation: conversationData,
        messageData,
      })
    );
    if (conversationData) {
      messageNotification(conversationData, messageData);
    }

    // if (data.messageType !== MessageType.IMAGE) {
    //   pub.publish(
    //     "SEND_MESSAGE",
    //     JSON.stringify({
    //       conversation: conversationData,
    //       messageData,
    //     })
    //   );
    // }

    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    console.error("Error sending message:", error instanceof Error ? error.message : "Unknown error");
    socket.emit("ERROR", { message: error instanceof Error ? error.message : "Unknown error" });
  } finally {
    session.endSession();
  }
};

const getAllMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { skip = "0", limit = "30", conversationId } = req.query;
    const skipNumber = parseInt(skip as string, 10);
    const limitNumber = parseInt(limit as string, 10);

    if (!conversationId) {
      res.status(400).json(messages.CONVERSATION_ID_REQUIRED);
      return;
    }
    const message = await messageModel
      .find({ conversation: conversationId })
      .sort({ createdAt: -1 })
      .skip(skipNumber)
      .limit(limitNumber)
      .lean();
    res.status(200).json({
      code: messages.SUCCESSFULLY.code,
      message: messages.SUCCESSFULLY.message,
      data: message,
    });
    return;
  } catch (error) {
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
    return;
  }
};

const getAllMessageHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const { skip = "0", limit = "30", orderId } = req.query;
    const skipNumber = parseInt(skip as string, 10);
    const limitNumber = parseInt(limit as string, 10);

    if (!orderId) {
      res.status(400).json(messages.CONVERSATION_ID_REQUIRED);
      return;
    }
    const conversation = await conversationModel.findOne({
      orderId: orderId,
    });
    if (!conversation) {
      res.status(404).json(messages.CONVERSATION_NOT_FOUND);
      return;
    }

    const message = await messageModel
      .find({ conversation: conversation._id })
      .sort({ createdAt: -1 })
      .skip(skipNumber)
      .limit(limitNumber)
      .lean();
    res.status(200).json({
      code: messages.SUCCESSFULLY.code,
      message: messages.SUCCESSFULLY.message,
      data: message,
    });
    return;
  } catch (error) {
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
    return;
  }
};

export { sendPrivateMessage, sendGroupMessage, getAllMessage, getAllMessageHistory };
