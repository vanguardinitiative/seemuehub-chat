import { messageModel } from "@/models/message";
import { messageStatusModel } from "@/models/messageStatus";
import { Request, Response } from "express";
import { messages } from "@/config";
import { conversationModel, IParticipant } from "@/models/conversation";
import { pub } from "@/config/redis";
import mongoose from "mongoose";
import { participantOf, userIdOf } from "@/utils/conversation-access";
import { allOthersRead, participantIdOf } from "@/utils/read-state";

interface ReadConversation {
  _id: mongoose.Types.ObjectId;
  conversationType?: string;
  participants?: Array<Partial<IParticipant>>;
  latestMessageData?: {
    senderId?: string;
    messageId?: string;
    sendAt?: Date;
    readAllAt?: Date | null;
  };
}

/**
 * PUT /message-status/read?conversationId= (worktrees/CHAT-CONTRACT.md §1.2).
 *
 * Marks the conversation read for the caller by moving their
 * `participants[].lastReadAt` forward, then sets `latestMessageData.readAllAt`
 * once everyone but the latest sender has read it. The body is ignored (the
 * old web sends `{userId}`; the reader is always the token's user).
 *
 * Every conversation write here is an update with `timestamps: false`:
 * - the list sorts by `updatedAt`, so reading must not move a chat to the top;
 * - this model's conversationType enum lacks the backend's ORDER, so a
 *   `.save()` of an order conversation would fail validation.
 */
const updateReadStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.query.conversationId) {
      res.status(400).json(messages.BAD_REQUEST);
      return;
    }
    const conversationId = String(req.query.conversationId);
    const readerId = userIdOf(req);
    if (!readerId) {
      res.status(401).json(messages.UNAUTHORIZED);
      return;
    }
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      res.status(400).json(messages.INVALID_CONVERSATION_ID);
      return;
    }

    // Record the read. Membership is part of the filter, so "not yours" and
    // "does not exist" are the same 404 (utils/conversation-access.ts). $max
    // keeps a read mark from moving back when two devices race.
    const now = new Date();
    const conversation = await conversationModel
      .findOneAndUpdate(
        { _id: conversationId, ...participantOf(readerId) },
        { $max: { "participants.$[me].lastReadAt": now } },
        {
          arrayFilters: [{ "me.user": new mongoose.Types.ObjectId(readerId) }],
          new: true,
          timestamps: false,
        }
      )
      .lean<ReadConversation>();
    if (!conversation) {
      console.warn("[access] read status refused", { conversationId, userId: readerId });
      res.status(404).json(messages.CONVERSATION_NOT_FOUND);
      return;
    }

    const participants = conversation.participants ?? [];
    const mine = participants.find((participant) => participantIdOf(participant) === readerId);
    const lastReadAt = mine?.lastReadAt ? new Date(mine.lastReadAt) : now;

    // Group chats keep their per-message receipts; private sends never
    // created any, which is why reads used to go nowhere.
    if (conversation.conversationType === "GROUP") {
      await messageStatusModel.updateMany(
        { conversation: conversationId, user: readerId, status: "UNREAD" },
        { $set: { status: "READ", readAt: now } }
      );
    }

    // Everyone but the latest sender has read it: say so, once. The messageId
    // and readAllAt conditions make a message that arrived since, or a second
    // reader racing this one, a no-op.
    const latest = conversation.latestMessageData ?? {};
    let readAllAt: Date | null = latest.readAllAt ? new Date(latest.readAllAt) : null;
    let readAllJustSet = false;
    if (!latest.readAllAt && latest.messageId && allOthersRead(conversation)) {
      const marked = await conversationModel.updateOne(
        { _id: conversationId, "latestMessageData.messageId": latest.messageId, "latestMessageData.readAllAt": null },
        { $set: { "latestMessageData.readAllAt": now } },
        { timestamps: false }
      );
      if (marked.modifiedCount > 0) {
        readAllJustSet = true;
        readAllAt = now;
        await messageModel.updateMany(
          {
            conversation: conversationId,
            readAllAt: null,
            sender: { $ne: readerId },
            sendAt: { $lte: latest.sendAt ?? now },
          },
          { $set: { readAllAt: now } },
          { timestamps: false }
        );
      }
    }

    // To the reader's own devices, and to the latest sender only when this
    // read is what made it read by all. Old app builds take any READ_MESSAGE
    // as "this chat is read for me", so it must reach nobody else.
    const userIds = [readerId];
    const senderId = latest.senderId ? String(latest.senderId) : null;
    if (
      readAllJustSet &&
      senderId &&
      senderId !== readerId &&
      participants.some((participant) => participantIdOf(participant) === senderId)
    ) {
      userIds.push(senderId);
    }
    void pub.publish(
      "READ_MESSAGE",
      JSON.stringify({
        userIds,
        conversationId,
        readerId,
        readAt: lastReadAt.toISOString(),
        readAllAt: readAllAt ? readAllAt.toISOString() : null,
      })
    );

    res.status(200).json({
      code: messages.SUCCESSFULLY.code,
      message: messages.SUCCESSFULLY.message,
      data: {
        conversationId,
        lastReadAt: lastReadAt.toISOString(),
        readAllAt: readAllAt ? readAllAt.toISOString() : null,
      },
    });
  } catch (error) {
    console.error("Error updating read status:", error);
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
  }
};

export { updateReadStatus };
