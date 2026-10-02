import mongoose from "mongoose";
import { Socket, Server } from "socket.io";
import { conversationModel, IParticipant } from "@/models/conversation";
import type { Request, Response } from "express";
import { messageModel, MessageType } from "@/models/message";
import { pub } from "@/config/redis";
import { createMessageStatuses, createOrGetConversation } from "./helper";
import { pushChatMessage } from "@/services/chat-push";
import { messages } from "@/config";
import { messageStatusModel } from "@/models/messageStatus";
import { participantOf, userIdOf } from "@/utils/conversation-access";
import { DELIVERY_FIELDS, deliverConversation } from "@/services/delivered";
import type { DeliveredConversation } from "@/utils/delivered";
import { logEvent, refuse } from "@/socket/auth";
import { resolveReply } from "./reply";
import { isBlocked } from "@/utils/org-chat";

/**
 * Thrown inside the send's transaction when the conversation is a company
 * conversation whose candidate blocked the company (ORG-CHAT-CONTRACT.md
 * §3.2): the transaction is aborted, so neither the message nor the
 * conversation's latest message is kept, and the sender gets ERROR
 * ORG_CHAT_BLOCKED.
 */
class BlockedConversationError extends Error {
  constructor() {
    super("ORG_CHAT_BLOCKED");
    this.name = "BlockedConversationError";
  }
}

interface MessageData {
  messageType: string;
  content: string;
  conversationId?: string;
  senderId: string;
  receiverId: string;
  _id?: string;
  /** The message this one answers (CHAT-CONTRACT.md §2.2); checked by resolveReply. */
  replyTo?: unknown;
}

/** Aborts the send's transaction; a failure to abort is logged, never thrown over the send's own error. */
const abortQuietly = async (session: mongoose.ClientSession): Promise<void> => {
  try {
    if (typeof session.inTransaction !== "function" || session.inTransaction()) {
      await session.abortTransaction();
    }
  } catch (error) {
    console.error("Error aborting message transaction:", error instanceof Error ? error.message : "Unknown error");
  }
};

/** A duplicate key on a message's _id (the only unique key a message has). */
const isDuplicateId = (error: unknown): boolean => {
  const { code, keyPattern } = (error ?? {}) as { code?: unknown; keyPattern?: Record<string, unknown> };
  if (code !== 11000) return false;
  return !keyPattern || Object.prototype.hasOwnProperty.call(keyPattern, "_id");
};

/**
 * A resend of a message that was already stored (CHAT-CONTRACT.md §1.7). A
 * client that never saw its NEW_MESSAGE come back (a dropped socket, a
 * timeout) sends it again with the same `_id`, and the insert hits the
 * duplicate key. If that `_id` is the same sender's stored message, the resend
 * is answered with the stored message on CONVERSATION_LISTENING NEW_MESSAGE,
 * to the resending socket only, instead of an ERROR: the retry confirms it.
 * Nothing is stored, published or pushed again. Someone else's `_id` is still
 * an error. Call it after the transaction is aborted: the lookup runs outside
 * it.
 */
const confirmResentMessage = async (
  socket: Socket,
  event: "NEW_MESSAGE" | "NEW_GROUP_MESSAGE",
  data: MessageData,
  error: unknown
): Promise<boolean> => {
  if (!data?._id || !data.senderId || !isDuplicateId(error)) return false;
  if (!mongoose.Types.ObjectId.isValid(data._id) || !mongoose.Types.ObjectId.isValid(String(data.senderId))) return false;
  const stored = await messageModel.findOne({ _id: data._id, sender: data.senderId }).lean();
  if (!stored) return false;
  // The shape SEND_MESSAGE delivers: the stored message through JSON.
  socket.emit("CONVERSATION_LISTENING", { type: "NEW_MESSAGE", response: JSON.parse(JSON.stringify(stored)) });
  logEvent({ msg: "message_resent", event, socketId: socket.id, userId: String(data.senderId), _id: String(data._id) });
  return true;
};

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
    // Checked against the conversation just resolved; an invalid reply is
    // dropped and the message still goes (CHAT-CONTRACT.md §2.2).
    const reply = await resolveReply(data.replyTo, newConversationId, session, {
      event: "NEW_MESSAGE",
      socketId: socket?.id,
      userId: String(data.senderId),
    });

    const [messageData] = await messageModel.create(
      [
        {
          ...data,
          ...reply,
          reactions: undefined,
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
          messageType: messageData.messageType,
          content: data.content,
          readAllAt: null,
          sendAt: new Date(),
          deliveredAllAt: new Date(),
        },
      },
      { new: true, session }
    );
    // Checked on the conversation the update returned, inside the
    // transaction, so a block that lands meanwhile is honoured too. Before
    // anything is published.
    if (isBlocked(conversationData)) throw new BlockedConversationError();
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

    // console.log("conversationData", conversationData);
    pub.publish(
      "SEND_MESSAGE",
      JSON.stringify({
        conversation: conversationData,
        messageData,
      })
    );


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

    // After the commit, and not awaited: a push to the other participants'
    // phones through the backend, which can neither delay nor fail the
    // message (src/services/chat-push.ts). Never to the sender.
    void pushChatMessage(conversationData, messageData);
  } catch (error) {
    await abortQuietly(session);
    if (error instanceof BlockedConversationError) {
      logEvent({ msg: "message_refused", event: "NEW_MESSAGE", code: "ORG_CHAT_BLOCKED", socketId: socket?.id, conversationId: data?.conversationId ?? null });
      refuse(socket, "NEW_MESSAGE", "ORG_CHAT_BLOCKED", { conversationId: data?.conversationId ?? null, _id: data?._id ?? null });
      return;
    }
    try {
      if (await confirmResentMessage(socket, "NEW_MESSAGE", data, error)) return;
    } catch (lookupError) {
      console.error("Error confirming a resent message:", lookupError instanceof Error ? lookupError.message : "Unknown error");
    }
    console.error("Error sending message:", error instanceof Error ? error.message : "Unknown error");
    socket.emit("ERROR", {
      code: "MESSAGE_SEND_FAILED",
      message: error instanceof Error ? error.message : "Unknown error",
      event: "NEW_MESSAGE",
      _id: data?._id ?? null,
    });
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
    const reply = await resolveReply(data.replyTo, newConversationId, session, {
      event: "NEW_GROUP_MESSAGE",
      socketId: socket?.id,
      userId: String(data.senderId),
    });

    const [messageData] = await messageModel.create(
      [
        {
          ...data,
          ...reply,
          reactions: undefined,
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
          messageType: messageData.messageType,
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
    // Read receipts only. This also posted a "TAXI" push payload to
    // NOTIFICATION_URL - a leftover of the product this service was forked
    // from, which sent Seemuehub message text and sender details to whatever
    // that URL pointed at (or failed against "localhost" when unset). No
    // Seemuehub client sends group messages; pushes for private ones go
    // through the backend (pushChatMessage above).
    if (conversationData) {
      createMessageStatuses(conversationData, messageData);
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
    await abortQuietly(session);
    try {
      if (await confirmResentMessage(socket, "NEW_GROUP_MESSAGE", data, error)) return;
    } catch (lookupError) {
      console.error("Error confirming a resent message:", lookupError instanceof Error ? lookupError.message : "Unknown error");
    }
    console.error("Error sending message:", error instanceof Error ? error.message : "Unknown error");
    socket.emit("ERROR", {
      code: "MESSAGE_SEND_FAILED",
      message: error instanceof Error ? error.message : "Unknown error",
      event: "NEW_GROUP_MESSAGE",
      _id: data?._id ?? null,
    });
  } finally {
    session.endSession();
  }
};

const getAllMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { skip = "0", limit = "30", conversationId } = req.query;
    const skipNumber = parseInt(skip as string, 10);
    const limitNumber = parseInt(limit as string, 10);

    const userId = userIdOf(req);
    if (!userId) {
      res.status(401).json(messages.UNAUTHORIZED);
      return;
    }
    if (!conversationId) {
      res.status(400).json(messages.CONVERSATION_ID_REQUIRED);
      return;
    }
    if (!mongoose.Types.ObjectId.isValid(String(conversationId))) {
      res.status(400).json(messages.INVALID_CONVERSATION_ID);
      return;
    }

    // messageModel has no participants array of its own to filter on, so
    // membership has to be established against the conversation first. Without
    // this the endpoint returned every message body to anyone holding any valid
    // token — and before the route gained middleware, to anyone at all.
    // The same membership-filtered findOne isParticipant does, reading what
    // the delivered mark below needs (DELIVERY_FIELDS).
    const conversation = await conversationModel
      .findOne({ _id: String(conversationId), ...participantOf(userId) })
      .select(DELIVERY_FIELDS)
      .lean<DeliveredConversation>();
    if (!conversation) {
      console.warn("[access] message read refused", { conversationId, userId });
      res.status(404).json(messages.CONVERSATION_NOT_FOUND);
      return;
    }

    const message = await messageModel
      .find({ conversation: conversationId })
      .sort({ createdAt: -1 })
      .skip(skipNumber)
      .limit(limitNumber)
      .lean();

    // These messages are on the caller's device now (CHAT-CONTRACT.md §5.1).
    // Never fails the GET.
    await deliverConversation(conversation, userId);

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

    const userId = userIdOf(req);
    if (!userId) {
      res.status(401).json(messages.UNAUTHORIZED);
      return;
    }
    if (!orderId) {
      res.status(400).json(messages.CONVERSATION_ID_REQUIRED);
      return;
    }

    // No extra query needed here — this lookup already existed, it just was not
    // scoped to the caller. The tightened filter rides the existing
    // {"participants.user":1, orderId:1} compound index.
    const conversation = await conversationModel
      .findOne({
        orderId: orderId,
        ...participantOf(userId),
      })
      .select("_id")
      .lean();
    if (!conversation) {
      console.warn("[access] message history refused", { orderId, userId });
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
