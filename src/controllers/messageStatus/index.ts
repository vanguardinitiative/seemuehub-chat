import { messageModel } from "@/models/message";
import { messageStatusModel } from "@/models/messageStatus";
import { Request, Response } from "express";
import { messages } from "@/config";
import { conversationModel, IParticipant } from "@/models/conversation";
import { pub } from "@/config/redis";
import mongoose from "mongoose";
import { participantOf, userIdOf } from "@/utils/conversation-access";
import { allOthersRead, covers, participantIdOf } from "@/utils/read-state";
import { deliveryMoves, otherParticipants } from "@/utils/delivered";
import { publishDelivered } from "@/services/delivered";
import { orgRoomOf } from "@/socket/rooms";
import { env } from "@/config/env";

interface ReadConversation {
  _id: mongoose.Types.ObjectId;
  conversationType?: string;
  organizationId?: unknown;
  participants?: Array<Partial<IParticipant>>;
  latestMessageData?: {
    senderId?: string;
    messageId?: string;
    sendAt?: Date;
    readAllAt?: Date | null;
  };
}

/**
 * The conversation as the read's update left it, from the copy it returned
 * from before: the reader's lastReadAt and lastDeliveredAt each moved to `at`
 * unless already later (the $max).
 */
const afterRead = (before: ReadConversation, readerId: string, at: Date): ReadConversation => ({
  ...before,
  participants: (before.participants ?? []).map((participant) =>
    participantIdOf(participant) === readerId
      ? {
          ...participant,
          lastReadAt: covers(participant.lastReadAt, at) ? participant.lastReadAt : at,
          lastDeliveredAt: covers(participant.lastDeliveredAt, at) ? participant.lastDeliveredAt : at,
        }
      : participant
  ),
});

/**
 * PUT /message-status/read?conversationId= (worktrees/CHAT-CONTRACT.md §1.2).
 *
 * Marks the conversation read (and delivered, §5.1) for the caller by moving
 * their `participants[].lastReadAt` and `lastDeliveredAt` forward, then sets
 * `latestMessageData.readAllAt` once everyone but the latest sender has read
 * it. The body is ignored (the
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
    // keeps a read mark from moving back when two devices race. Reading also
    // delivers (CHAT-CONTRACT.md §5.1), in the same update. It returns the
    // conversation as it was before, which is how this knows whether the
    // delivered mark has just moved past the latest message; afterRead gives
    // the conversation as it is now.
    const now = new Date();
    const before = await conversationModel
      .findOneAndUpdate(
        { _id: conversationId, ...participantOf(readerId) },
        { $max: { "participants.$[me].lastReadAt": now, "participants.$[me].lastDeliveredAt": now } },
        {
          arrayFilters: [{ "me.user": new mongoose.Types.ObjectId(readerId) }],
          returnDocument: "before",
          timestamps: false,
        }
      )
      .lean<ReadConversation>();
    if (!before) {
      console.warn("[access] read status refused", { conversationId, userId: readerId });
      res.status(404).json(messages.CONVERSATION_NOT_FOUND);
      return;
    }
    const conversation = afterRead(before, readerId, now);

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
    // A candidate's read of a company conversation: the company's inbox hears
    // it too (ORG-CHAT-CONTRACT.md §3.4), on its org room. Its members are
    // not participants, so they are never in userIds.
    const orgRoom = env.ORG_CHAT_ENABLED === "true" ? orgRoomOf(before.organizationId) : null;
    void pub.publish(
      "READ_MESSAGE",
      JSON.stringify({
        userIds,
        conversationId,
        readerId,
        readAt: lastReadAt.toISOString(),
        readAllAt: readAllAt ? readAllAt.toISOString() : null,
        ...(orgRoom ? { orgRoom } : {}),
      })
    );

    // This read is also what delivered the latest message from someone else:
    // the other participants hear DELIVERED (CHAT-CONTRACT.md §5.1).
    if (deliveryMoves(before, readerId, now)) {
      publishDelivered({ userIds: otherParticipants(before, readerId), conversationId, userId: readerId, deliveredAt: now.toISOString() });
    }

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
