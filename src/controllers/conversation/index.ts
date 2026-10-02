import { messages } from "@/config";
import { conversationModel, OrderStatus, UserType } from "@/models/conversation";
import { messageStatusModel } from "@/models/messageStatus";
import { staffModel } from "@/models/staff";
import { userModel } from "@/models/user";
import { Request, Response } from "express";
import mongoose, { Types } from "mongoose";
import { StaffRole } from "./helper";
import { participantOf, userIdOf } from "@/utils/conversation-access";
import { isReadFor, type ReadStateConversation } from "@/utils/read-state";

/**
 * The caller's legacy MessageStatus verdict per message id: true for READ,
 * false for UNREAD, absent when there is no row. Only group sends still write
 * these rows; private reads live in `participants[].lastReadAt`.
 */
const legacyReadMap = async (messageIds: unknown[], userId: string): Promise<Map<string, boolean>> => {
  const ids = messageIds.map((id) => (id == null ? "" : String(id))).filter((id) => Types.ObjectId.isValid(id));
  const statusMap = new Map<string, boolean>();
  if (ids.length === 0) return statusMap;
  const statuses = await messageStatusModel
    .find({ message: { $in: ids }, user: new Types.ObjectId(userId) })
    .select("message status")
    .lean<Array<{ message: Types.ObjectId; status: string }>>();
  for (const status of statuses) statusMap.set(status.message.toString(), status.status === "READ");
  return statusMap;
};

const createPrivateConversation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { receiverId, orderId, orderStatus, orderTitle, orderBudget, orderDeadline, orderPriority } = req.body;

    // The sender is whoever holds the token, full stop.
    //
    // Reading it from the body made this an unauthenticated oracle: post any two
    // user ids and the $all filter below would tell you whether they have a
    // conversation, hand back its id, and populate both parties' contact
    // details. Taking it from the token also makes that same filter do the
    // authorization work, since a caller can now only ever match conversations
    // they are in.
    //
    // Both web call sites already send senderId = the current user, so this
    // changes nothing for the real client.
    const senderId = userIdOf(req);
    if (!senderId) {
      res.status(401).json(messages.UNAUTHORIZED);
      return;
    }
    if (req.body.senderId && String(req.body.senderId) !== senderId) {
      console.warn("[access] senderId in body ignored", { claimed: req.body.senderId, actual: senderId });
    }

    if (!receiverId) {
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
      .populate("participants.user", "userName displayName isFreelancer phone email role profileImage");

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
    //   .populate("participants.user", "userName displayName isFreelancer phone email role profileImage isOnline");

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
      .populate("participants.user", "userName displayName isFreelancer phone email role profileImage");
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
      .populate("participants.user", "userName displayName isFreelancer phone email role profileImage isOnline");

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

    const userId = userIdOf(req);
    if (!userId) {
      res.status(401).json(messages.UNAUTHORIZED);
      return;
    }

    // findOne({_id}) on a string that is not an ObjectId throws a CastError,
    // which this handler's catch turns into a 500. It is a bad request.
    if (!Types.ObjectId.isValid(String(id))) {
      res.status(400).json(messages.INVALID_CONVERSATION_ID);
      return;
    }

    const conversation = await conversationModel
      .findOne({
        _id: id,
        ...participantOf(userId),
      })
      .populate("participants.user", "userName displayName isFreelancer phone email role profileImage");
    if (!conversation) {
      // 404 rather than 403, and deliberately the same 404 a missing
      // conversation gets. A 403 would confirm the id is real, which is exactly
      // what an enumerator is after — ObjectIds carry a timestamp prefix, so ids
      // near a known one are cheap to guess. The two cases are separated in the
      // log, not in the response.
      console.warn("[access] conversation read refused", { conversationId: id, userId });
      res.status(404).json(messages.CONVERSATION_NOT_FOUND);
      return;
    }
    // What res.json would have sent (toJSON), plus latestMessageData.isRead
    // for the caller (CHAT-CONTRACT.md §1.4). The legacy MessageStatus row is
    // only looked up when lastReadAt does not already settle it.
    const data: any =
      typeof (conversation as any).toJSON === "function" ? (conversation as any).toJSON() : { ...(conversation as any) };
    if (data.latestMessageData) {
      const messageId = data.latestMessageData.messageId;
      let isRead = isReadFor(data, userId);
      if (!isRead && messageId) {
        isRead = isReadFor(data, userId, (await legacyReadMap([messageId], userId)).get(String(messageId)));
      }
      data.latestMessageData = { ...data.latestMessageData, isRead };
    }
    res.status(200).json({
      code: messages.SUCCESSFULLY.code,
      message: messages.SUCCESSFULLY.message,
      data,
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

interface IConversationData extends ReadStateConversation {
  latestMessage?: ILatestMessage;
  latestMessageIsRead?: boolean;
  latestMessageData?: {
    messageId?: Types.ObjectId | string;
    senderId?: string;
    sendAt?: Date;
    isRead?: boolean;
  };
  updatedAt: Date;
}

const getAllConversions = async (req: Request, res: Response): Promise<void> => {
  try {
    const { search, skip = "0", limit = "100", orderStatus } = req.query as QueryParams;
    const userId = (req as any).user.userId;
    const skipNumber = parseInt(skip, 10);
    const limitNumber = parseInt(limit, 10);
    const query: ConversationQuery = {
      "participants.user": new Types.ObjectId(userId),
    };
    // No filter means every conversation, cancelled orders included.
    //
    // This used to default to `orderStatus: { $ne: CANCELLED }`. Once the
    // backend began syncing CANCELLED onto the conversation when an order is
    // cancelled (seemuehub-backend#39), that default made the chat vanish the
    // moment its order was cancelled: the list is how the clients find an
    // order's conversation, so its history could no longer be opened at all.
    // The clients split active from history themselves; a caller that only
    // wants the open ones asks for NOT_COMPLETE.
    if (orderStatus) {
      if (orderStatus === "NOT_COMPLETE") {
        // Exclude COMPLETED and CANCELLED
        query.orderStatus = { $nin: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] };
      } else {
        query.orderStatus = orderStatus; // accepts CANCELLED, COMPLETED, etc.
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

    const conversations = await conversationModel
      .find(query)
      .populate("participants.user", "userName phone email role profileImage isOnline isFreelancer displayName")
      .sort({ updatedAt: -1 })
      .lean<IConversationData[]>();

    const statusMap = await legacyReadMap(
      conversations.map((c) => c.latestMessageData?.messageId),
      userId
    );

    // isRead is the caller's: they sent the latest message, or their
    // participants[].lastReadAt covers it, or (groups) its MessageStatus row
    // says READ. participants[].lastReadAt goes out as is (CHAT-CONTRACT.md §1.4).
    const conversationData = conversations.map((conversation) => {
      if (conversation.latestMessageData) {
        const messageId = conversation.latestMessageData.messageId;
        conversation.latestMessageData = {
          ...conversation.latestMessageData,
          isRead: isReadFor(conversation, userId, messageId ? statusMap.get(messageId.toString()) : undefined),
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
