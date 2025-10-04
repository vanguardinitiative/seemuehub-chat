import { messageModel } from "@/models/message";
import { messageStatusModel } from "@/models/messageStatus";
import { Request, Response } from "express";
import { messages } from "@/config";
import { conversationModel, UserType } from "@/models/conversation";
import { pub } from "@/config/redis";

const updateReadStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log("user data", (req as any).user);
    const { conversationId } = req.query;

    // Input validation
    if (!conversationId) {
      res.status(400).json(messages.BAD_REQUEST);
      return;
    }
    const receiverId = (req as any).user.userId;
    //step1: ເອົາຂໍ້ມູນຂອງ conversation
    const conversation = await conversationModel.findById(conversationId);
    if (!conversation) {
      res.status(404).json(messages.NOT_FOUND);
      return;
    }
    console.log("conversation", conversation.latestMessageData.senderId);
    //find the senderId is customer or staff
    const userData = conversation.participants.find(
      (participant) => participant.user.toString() == conversation.latestMessageData.senderId
    );
    console.log("userData", userData);
    if (!userData) {
      res.status(404).json(messages.NOT_FOUND);
      return;
    }
    //userType is  user
    let userIds: string[] = [];
    if (userData?.userType === UserType.USER) {
      if (conversation.conversationType == "PRIVATE") {
        //the userIs is should not equal to the receiverId
        userIds = conversation.participants
          .filter((participant) => participant.user.toString() !== receiverId)
          .map((participant) => participant.user.toString());
      } else {
        // If customer sent the message, notify all staff members
        userIds = conversation.participants
          .filter((participant) => participant.userType === UserType.ADMIN)
          .map((participant) => participant.user.toString());
      }
    } else if (userData.userType === UserType.ADMIN) {
      // If staff sent the message, notify the customer
      userIds = conversation.participants
        .filter((participant) => participant.userType === UserType.USER)
        .map((participant) => participant.user.toString());
    }
    const messagesData = await messageModel.findOne({
      _id: conversation.latestMessageData.messageId,
      readAllAt: null,
    });

    console.log("messagesData", messagesData);
    if (!messagesData) {
      res.status(200).json({
        code: messages.SUCCESSFULLY.code,
        message: messages.SUCCESSFULLY.message,
        data: {},
      });
      return;
    }
    const currentTime = Date.now();
    await messageStatusModel.updateMany(
      {
        user: receiverId,
        status: "UNREAD",
        conversation: conversationId,
      },
      {
        readAt: currentTime,
        status: "READ",
      }
    );

    console.log("userIds", userIds);

    const messageStatusData = await messageStatusModel.find({
      conversation: conversationId,
      message: messagesData._id,
      status: "READ",
      user: { $in: userIds },
    });
    if (messageStatusData.length === 0) {
      res.status(200).json({
        code: messages.SUCCESSFULLY.code,
        message: messages.SUCCESSFULLY.message,
        data: {},
      });
      return;
    }
    //check if the user is read in the message status is equal the user in participants type USER and S

    await Promise.all([
      messageModel.updateMany({ conversation: conversationId, readAllAt: null }, { readAllAt: currentTime }),
      conversationModel.updateOne({ _id: conversationId }, { "latestMessageData.readAllAt": currentTime }),
      messageStatusModel.updateMany(
        { conversation: conversationId, status: "UNREAD" },
        { status: "READ", readAt: currentTime }
      ),
    ]);
    pub.publish(
      "READ_MESSAGE",
      JSON.stringify({
        userIds: conversation.participants.map((participant) => participant.user.toString()),
        conversationId,
      })
    );
    res.status(200).json({
      code: messages.SUCCESSFULLY.code,
      message: messages.SUCCESSFULLY.message,
      data: { conversationId },
    });
    return;
  } catch (error) {
    console.error("Error updating read status:", error);
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
    return;
  }
};

export { updateReadStatus };
