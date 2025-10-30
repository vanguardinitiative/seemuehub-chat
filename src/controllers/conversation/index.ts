import { messages } from "@/config";
import { conversationModel, OrderStatus, UserType } from "@/models/conversation";
import { messageStatusModel } from "@/models/messageStatus";
import { staffModel } from "@/models/staff";
import { userModel } from "@/models/user";
import { Request, Response } from "express";
import mongoose, { Types } from "mongoose";
import { StaffRole } from "./helper";

const createPrivateConversation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { senderId, receiverId, orderId, orderStatus, orderTitle, orderBudget, orderDeadline, orderPriority } =
      req.body;

    if (!senderId || !receiverId) {
      res.status(400).json(messages.BAD_REQUEST);
      return;
    }

    if (senderId === receiverId) {
      res.status(400).json(messages.SELF_CONVERSATION_NOT_ALLOWED);
      return;
    }
    // delay 3 second
    // await new Promise((resolve) => setTimeout(resolve, 3000));

    // Check for existing conversation with orderId
    const existingConversation = await conversationModel
      .findOne({
        // conversationType: "PRIVATE",
        orderId: orderId,
        participants: {
          $all: [{ $elemMatch: { user: senderId } }, { $elemMatch: { user: receiverId } }],
        },
      })
      .populate("participants.user", "fullName phone email role profileImage");

    console.log("existingConversation===>", existingConversation);

    // if (existingConversation) {
    //   res.status(200).json({
    //     code: messages.SUCCESSFULLY.code,
    //     message: messages.SUCCESSFULLY.message,
    //     data: existingConversation,
    //   });
    //   return;
    // }

    // // Private conversations are only for regular users (not staff/admin)
    // // Verify both participants are regular users
    // const sender = await userModel.findById(senderId);
    // const receiver = await userModel.findById(receiverId);

    // if (!sender || !receiver) {
    //   res.status(400).json({
    //     code: "CHAT-400",
    //     message: "Both participants must be regular users for private conversations",
    //   });
    //   return;
    // }

    // // Both participants are regular users
    // const senderType = UserType.USER;
    // const receiverType = UserType.USER;

    // const participants = [
    //   { user: senderId, joinDate: Date.now(), userType: senderType },
    //   { user: receiverId, joinDate: Date.now(), userType: receiverType },
    // ];

    // // Create conversation with order integration
    // const conversationData: any = {
    //   participants,
    //   conversationType: "PRIVATE",
    //   orderId: orderId,
    //   latestMessageData: {
    //     isDeleted: false,
    //   },
    // };

    // // Add order-related fields if provided
    // if (orderStatus) conversationData.orderStatus = orderStatus;
    // if (orderTitle) conversationData.orderTitle = orderTitle;
    // if (orderBudget) conversationData.orderBudget = orderBudget;
    // if (orderDeadline) conversationData.orderDeadline = new Date(orderDeadline);
    // if (orderPriority) conversationData.orderPriority = orderPriority;
    // if (orderId) conversationData.isOrderActive = true;

    // const newConversation = await conversationModel.create(conversationData);

    // const fullConversation = await conversationModel
    //   .findOne({
    //     _id: newConversation._id,
    //   })
    //   .populate("participants.user", "fullName phone email role profileImage isOnline");

    res.status(201).json({
      code: messages.CREATE_SUCCESSFUL.code,
      message: messages.CREATE_SUCCESSFUL.message,
      data: existingConversation,
    });
    return;
  } catch (error) {
    console.log("Error creating private conversation:", error);
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
    return;
  }
};
const createGroupConversation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { senderId, platform } = req.body;

    const existingConversation = await conversationModel
      .findOne({
        conversationType: "GROUP",
        participants: {
          $all: [{ $elemMatch: { user: senderId } }],
        },
      })
      .populate("participants.user", "fullName phone email role profileImage");
    console.log("step 2");

    if (existingConversation) {
      res.status(200).json({
        code: messages.SUCCESSFULLY.code,
        message: messages.SUCCESSFULLY.message,
        data: existingConversation,
      });
      return;
    }
    let senderType = UserType.ADMIN;
    const sender = await staffModel.findById(senderId);
    if (!sender) {
      senderType = UserType.USER;
    }

    let role: StaffRole[] = ["SUPER_ADMIN", "TAXI_ADMIN", "TAXI_MANAGER", "TAXI_STAFF"];
    if (platform === "EXPRESS") {
      role = ["SUPER_ADMIN", "EXPRESS_ADMIN", "EXPRESS_MANAGER", "EXPRESS_STAFF"];
    }
    // const allStaff = await staffModel.find({}, "_id").lean();
    const allStaff = await staffModel.find({ role: { $in: role } }, "_id").lean();

    console.log("senderType======>", senderType);
    const participants = [
      { user: senderId, joinDate: Date.now(), userType: senderType },
      ...allStaff.map((staff) => ({
        user: staff._id,
        joinDate: Date.now(),
        userType: UserType.ADMIN,
      })),
    ];

    const newConversation = await conversationModel.create({
      participants,
      conversationType: "GROUP",
      conversationName: "SUPPORT_GROUP",
      latestMessageData: {
        isDeleted: false,
      },
    });

    const fullConversation = await conversationModel
      .findOne({
        _id: newConversation._id,
      })
      .populate("participants.user", "fullName phone email role profileImage isOnline");

    res.status(201).json({
      code: messages.CREATE_SUCCESSFUL.code,
      message: messages.CREATE_SUCCESSFUL.message,
      data: fullConversation,
    });
    return;
  } catch (error) {
    console.log(error);
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
    return;
  }
};

const getConversation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json(messages.BAD_REQUEST);
      return;
    }

    console.log("Registered models:", mongoose.modelNames());

    const conversation = await conversationModel
      .findOne({
        _id: id,
      })
      .populate("participants.user", "fullName phone email role profileImage");
    if (!conversation) {
      res.status(404).json(messages.CONVERSATION_NOT_FOUND);
      return;
    }
    res.status(200).json({
      code: messages.SUCCESSFULLY.code,
      message: messages.SUCCESSFULLY.message,
      data: conversation,
    });
    return;
  } catch (error) {
    console.log("error====>", error);
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
    return;
  }
};
interface QueryParams extends Record<string, unknown> {
  search?: string;
  skip?: string;
  limit?: string;
  orderStatus?: string;
}

interface ConversationQuery {
  "participants.user": Types.ObjectId;
  orderStatus?: any;
  $or?: Array<{
    conversationType?: "GROUP";
    conversationName?: { $regex: string; $options: string };
    "participants.user"?: { $in: Types.ObjectId[] };
  }>;
}

interface ILatestMessage {
  _id: Types.ObjectId;
  sender?: {
    _id: Types.ObjectId;
  };
  isRead?: boolean;
}

interface IConversationData {
  latestMessage?: ILatestMessage;
  latestMessageIsRead?: boolean;
  latestMessageData?: {
    messageId: Types.ObjectId;
    isRead?: boolean;
  };
  updatedAt: Date;
}

const getAllConversions = async (req: Request, res: Response): Promise<void> => {
  try {
    const { search, skip = "0", limit = "100", orderStatus } = req.query as QueryParams;
    const userId = (req as any).user.userId;
    console.log("data   ===> ", (req as any).user);
    const skipNumber = parseInt(skip, 10);
    const limitNumber = parseInt(limit, 10);
    const query: ConversationQuery = {
      "participants.user": new Types.ObjectId(userId),
    };
    if (orderStatus) {
      if (orderStatus === "NOT_COMPLETE") {
        query.orderStatus = { $ne: OrderStatus.COMPLETED };
      } else {
        query.orderStatus = orderStatus;
      }
    }

    if (search) {
      const userSearchResults = await userModel
        .find(
          {
            $or: [{ fullName: { $regex: search, $options: "i" } }, { nickname: { $regex: search, $options: "i" } }],
          },
          { _id: 1 }
        )
        .lean<Array<{ _id: Types.ObjectId }>>();

      query.$or = [
        {
          conversationType: "GROUP",
          conversationName: { $regex: search, $options: "i" },
        },
        {
          "participants.user": {
            $in: userSearchResults.map((user) => user._id),
          },
        },
      ];
    }

    console.log("query  ===> ", query);

    const conversations = await conversationModel
      .find(query)
      .populate("participants.user", "userName phone email role profileImage isOnline isFreelancer displayName")
      .sort({ updatedAt: -1 })
      .lean<IConversationData[]>();

    const messageIds = conversations
      .map((c) => c.latestMessageData?.messageId)
      .filter((id): id is Types.ObjectId => id != null);

    console.log("messageIds  ===> ", messageIds);
    const messageStatuses = await messageStatusModel
      .find({
        message: { $in: messageIds },
        user: new Types.ObjectId(userId),
      })
      .select("message status")
      .lean<Array<{ message: Types.ObjectId; status: string }>>();

    console.log("messageStatuses  ===> ", messageStatuses);
    const statusMap = new Map<string, boolean>();
    messageStatuses.forEach((status) => {
      statusMap.set(status.message.toString(), status.status === "READ");
    });
    console.log("statusMap  ===> ", statusMap);

    const conversationData = conversations.map((conversation) => {
      if (conversation.latestMessageData?.messageId) {
        conversation.latestMessageData = {
          ...conversation.latestMessageData,
          isRead: statusMap.get(conversation.latestMessageData.messageId.toString()) || false,
        };
      }
      return conversation;
    });

    conversationData.sort((a, b) => {
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });

    const paginatedResults = conversationData.slice(skipNumber, skipNumber + limitNumber);

    res.status(200).json({
      code: messages.SUCCESSFULLY.code,
      message: messages.SUCCESSFULLY.message,
      data: paginatedResults,
    });
  } catch (error) {
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
  }
};

export { createPrivateConversation, createGroupConversation, getConversation, getAllConversions };
