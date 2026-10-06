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
import { isCompletedOrderChat } from "@/utils/order-chat";
import { withSendTransaction } from "@/utils/transaction";
import { serialize } from "@/utils/serialize";

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

/**
 * Thrown inside the send's transaction when the conversation is an order's
 * chat and the order is COMPLETED (CHAT-CONTRACT.md §1.10): the transaction
 * is aborted - not retried, it is not transient - so neither the message nor
 * the conversation's latest message is kept, nothing is published or pushed,
 * and the sender gets ERROR ORDER_COMPLETED.
 */
class OrderCompletedError extends Error {
  constructor(readonly conversationId: string | null) {
    super("ORDER_COMPLETED");
    this.name = "OrderCompletedError";
  }
}

/** Refuses a send in a COMPLETED order's chat, on the conversation the send's update returned. */
const refuseCompletedOrderChat = (conversation: { _id?: unknown; orderStatus?: unknown } | null): void => {
  if (isCompletedOrderChat(conversation)) throw new OrderCompletedError(conversation?._id ? String(conversation._id) : null);
};

/** ERROR ORDER_COMPLETED to the sender, with the ids MESSAGE_SEND_FAILED carries. */
const refuseOrderCompleted = (socket: Socket, event: SendEvent, data: MessageData, error: OrderCompletedError): void => {
  const conversationId = data?.conversationId ?? error.conversationId ?? null;
  logEvent({ msg: "message_refused", event, code: "ORDER_COMPLETED", socketId: socket?.id, userId: data?.senderId ? String(data.senderId) : null, conversationId });
  refuse(socket, event, "ORDER_COMPLETED", { conversationId, _id: data?._id ?? null });
};

interface MessageData {
  messageType: string;
  content: string;
  conversationId?: string;
  senderId: string;
  /**
   * Only for a message without a conversationId: the other person of the
   * private conversation to find or create. With a conversationId it is not
   * read - the conversation says who hears it - so a company conversation,
   * which has no other participant, needs none. Clients still send one there
   * (the organization's id, or the candidate's own id); it is ignored.
   */
  receiverId?: string;
  _id?: string;
  /** The message this one answers (CHAT-CONTRACT.md §2.2); checked by resolveReply. */
  replyTo?: unknown;
}

/** A duplicate key on a message's _id (the only unique key a message has). */
const isDuplicateId = (error: unknown): boolean => {
  const { code, keyPattern } = (error ?? {}) as { code?: unknown; keyPattern?: Record<string, unknown> };
  if (code !== 11000) return false;
  return !keyPattern || Object.prototype.hasOwnProperty.call(keyPattern, "_id");
};

type SendEvent = "NEW_MESSAGE" | "NEW_GROUP_MESSAGE";

/**
 * A resend of a message that was already stored (CHAT-CONTRACT.md §1.7). A
 * client that never saw its NEW_MESSAGE come back (a dropped socket, a
 * timeout) sends it again with the same `_id`, and the insert hits the
 * duplicate key. If that `_id` is the same sender's stored message, the resend
 * is answered with the stored message on CONVERSATION_LISTENING NEW_MESSAGE,
 * to the resending socket only, instead of an ERROR: the retry confirms it.
 * Nothing is stored, published or pushed again. Someone else's `_id` is still
 * an error. The same goes for the send's own retry (utils/transaction.ts)
 * after a commit that went through unseen: `messageId` is then the id the
 * service chose. Call it after the transaction is over: the lookup runs
 * outside it.
 */
const confirmResentMessage = async (
  socket: Socket,
  event: SendEvent,
  data: MessageData,
  messageId: string | null,
  error: unknown
): Promise<boolean> => {
  if (!messageId || !data?.senderId || !isDuplicateId(error)) return false;
  if (!mongoose.Types.ObjectId.isValid(messageId) || !mongoose.Types.ObjectId.isValid(String(data.senderId))) return false;
  const stored = await messageModel.findOne({ _id: messageId, sender: data.senderId }).lean();
  if (!stored) return false;
  // The shape SEND_MESSAGE delivers: the stored message through JSON.
  socket.emit("CONVERSATION_LISTENING", { type: "NEW_MESSAGE", response: JSON.parse(JSON.stringify(stored)) });
  logEvent({ msg: "message_resent", event, socketId: socket.id, userId: String(data.senderId), _id: messageId });
  return true;
};

/**
 * The queue a send waits in (utils/serialize.ts): its conversation, or for a
 * first message, which has none yet, the two people whose conversation it
 * finds or creates. Null for a payload that is refused anyway.
 */
const sendQueueKey = (data: MessageData): string | null => {
  if (data?.conversationId) return `conversation:${String(data.conversationId)}`;
  if (data?.senderId && data?.receiverId) return `pair:${[String(data.senderId), String(data.receiverId)].sort().join(":")}`;
  return null;
};

/**
 * Runs a send once the sends that came before it to the same conversation
 * are done, so they commit one at a time, in order, instead of conflicting on
 * the conversation document. The place in line is taken by this call.
 */
const inConversationOrder = (data: MessageData, send: () => Promise<void>): Promise<void> => {
  const key = sendQueueKey(data);
  return key ? serialize(key, send) : send();
};

/** One JSON line per retried send (utils/transaction.ts), ids only. */
const logRetry = (socket: Socket, event: SendEvent, data: MessageData) => (attempt: number, error: unknown) => {
  logEvent({
    msg: "message_send_retry",
    event,
    attempt,
    code: (error as { code?: unknown } | null)?.code ?? null,
    socketId: socket?.id,
    userId: String(data.senderId),
    conversationId: data.conversationId ?? null,
    _id: data._id ?? null,
  });
};

/**
 * SEND_MESSAGE for a message whose transaction committed: never before, so a
 * message that was not kept is never delivered. Never throws: the message is
 * stored whatever happens here.
 */
const publishStoredMessage = (conversationData: unknown, messageData: unknown): void => {
  try {
    void pub.publish("SEND_MESSAGE", JSON.stringify({ conversation: conversationData, messageData }));
  } catch (error) {
    console.error("Error publishing a stored message:", error instanceof Error ? error.message : "Unknown error");
  }
};

/**
 * A send that was not stored: ERROR MESSAGE_SEND_FAILED to the sender, with
 * its `_id` and `conversationId` to find the message by. Unless the duplicate
 * key says it is stored after all (confirmResentMessage).
 */
const failSend = async (
  socket: Socket,
  event: SendEvent,
  data: MessageData,
  error: unknown,
  messageId: string | null
): Promise<void> => {
  try {
    if (await confirmResentMessage(socket, event, data, messageId, error)) return;
  } catch (lookupError) {
    console.error("Error confirming a resent message:", lookupError instanceof Error ? lookupError.message : "Unknown error");
  }
  console.error("Error sending message:", error instanceof Error ? error.message : "Unknown error");
  socket.emit("ERROR", {
    code: "MESSAGE_SEND_FAILED",
    message: error instanceof Error ? error.message : "Unknown error",
    event,
    conversationId: data?.conversationId ?? null,
    _id: data?._id ?? null,
  });
};

/**
 * The id a failed send's duplicate key is checked against: the client's, or,
 * once the transaction has been retried, the one the service chose (an
 * earlier run may have committed it).
 */
const resentIdOf = (data: MessageData, messageId: mongoose.Types.ObjectId | null, attempts: number): string | null => {
  if (data?._id) return String(data._id);
  return messageId && attempts > 1 ? String(messageId) : null;
};

const sendPrivateMessage = (socket: Socket, io: Server, data: MessageData): Promise<void> =>
  inConversationOrder(data, () => storePrivateMessage(socket, data));

const storePrivateMessage = async (socket: Socket, data: MessageData): Promise<void> => {
  let attempts = 0;
  let customId: mongoose.Types.ObjectId | null = null;

  try {
    if (data._id && !mongoose.Types.ObjectId.isValid(data._id)) {
      throw new Error("Invalid _id format");
    }

    if (!data.messageType || !data.content || !data.senderId || (!data.conversationId && !data.receiverId)) {
      throw new Error("messageType, content, senderId, and a conversationId or receiverId are required");
    }

    // Chosen once: a retried transaction inserts the same message.
    const messageId = data._id ? new mongoose.Types.ObjectId(data._id) : new mongoose.Types.ObjectId();
    customId = messageId;

    const { conversationData, messageData } = await withSendTransaction(
      async (session, attempt) => {
        attempts = attempt;
        const conversation = !data.conversationId
          ? await createOrGetConversation(data.senderId, data.receiverId as string, session)
          : null;

        const newConversationId = conversation?._id || data.conversationId;
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
              _id: messageId,
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
        // transaction, so a block - or the order completing - that lands
        // meanwhile is honoured too.
        if (isBlocked(conversationData)) throw new BlockedConversationError();
        refuseCompletedOrderChat(conversationData);
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
        return { conversationData, messageData };
      },
      { onRetry: logRetry(socket, "NEW_MESSAGE", data) }
    );

    publishStoredMessage(conversationData, messageData);

    // After the commit, and not awaited: a push to the other participants'
    // phones through the backend, which can neither delay nor fail the
    // message (src/services/chat-push.ts). Never to the sender.
    void pushChatMessage(conversationData, messageData);
  } catch (error) {
    if (error instanceof BlockedConversationError) {
      logEvent({ msg: "message_refused", event: "NEW_MESSAGE", code: "ORG_CHAT_BLOCKED", socketId: socket?.id, conversationId: data?.conversationId ?? null });
      refuse(socket, "NEW_MESSAGE", "ORG_CHAT_BLOCKED", { conversationId: data?.conversationId ?? null, _id: data?._id ?? null });
      return;
    }
    if (error instanceof OrderCompletedError) return refuseOrderCompleted(socket, "NEW_MESSAGE", data, error);
    await failSend(socket, "NEW_MESSAGE", data, error, resentIdOf(data, customId, attempts));
  }
};

const sendGroupMessage = (socket: Socket, io: Server, data: MessageData): Promise<void> =>
  inConversationOrder(data, () => storeGroupMessage(socket, data));

const storeGroupMessage = async (socket: Socket, data: MessageData): Promise<void> => {
  let attempts = 0;
  let customId: mongoose.Types.ObjectId | null = null;

  try {
    if (data._id && !mongoose.Types.ObjectId.isValid(data._id)) {
      throw new Error("Invalid _id format");
    }

    if (!data.messageType || !data.content || !data.senderId || !data.conversationId) {
      throw new Error("messageType, content, senderId, and receiverId are required");
    }
    const newConversationId = data.conversationId;
    // Chosen once: a retried transaction inserts the same message.
    const messageId = data._id ? new mongoose.Types.ObjectId(data._id) : new mongoose.Types.ObjectId();
    customId = messageId;

    const { conversationData, messageData } = await withSendTransaction(
      async (session, attempt) => {
        attempts = attempt;
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
              _id: messageId,
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
        // As in a private send: an order's chat closes when it completes.
        refuseCompletedOrderChat(conversationData);
        return { conversationData, messageData };
      },
      { onRetry: logRetry(socket, "NEW_GROUP_MESSAGE", data) }
    );

    publishStoredMessage(conversationData, messageData);
    // Read receipts only. This also posted a "TAXI" push payload to
    // NOTIFICATION_URL - a leftover of the product this service was forked
    // from, which sent Seemuehub message text and sender details to whatever
    // that URL pointed at (or failed against "localhost" when unset). No
    // Seemuehub client sends group messages; pushes for private ones go
    // through the backend (pushChatMessage above).
    if (conversationData) {
      void createMessageStatuses(conversationData, messageData);
    }
  } catch (error) {
    if (error instanceof OrderCompletedError) return refuseOrderCompleted(socket, "NEW_GROUP_MESSAGE", data, error);
    await failSend(socket, "NEW_GROUP_MESSAGE", data, error, resentIdOf(data, customId, attempts));
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
