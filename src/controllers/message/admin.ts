import type { Request, Response } from "express";
import mongoose from "mongoose";

import { messages } from "@/config";
import { messageModel } from "@/models/message";

/**
 * Oversight transcript: any conversation's messages.
 *
 * `getAllMessage` gates on `isParticipant`, which is correct for members and
 * exactly what an admin investigating a dispute cannot satisfy. This is the
 * same query without that probe, behind `requireAdminMiddleware`.
 *
 * Returned oldest-first so the transcript reads top to bottom, unlike the
 * member endpoint which pages backwards from the newest message.
 */
const getMessagesAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { skip = "0", limit = "100", conversationId } = req.query as Record<string, string>;
    const skipNumber = Number.parseInt(skip, 10) || 0;
    const limitNumber = Math.min(Number.parseInt(limit, 10) || 100, 200);

    if (!conversationId) {
      res.status(400).json(messages.CONVERSATION_ID_REQUIRED);
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      res.status(400).json(messages.INVALID_CONVERSATION_ID);
      return;
    }

    const [items, total] = await Promise.all([
      messageModel
        .find({ conversation: conversationId })
        .populate("sender", "userName displayName profileImage")
        .sort({ createdAt: 1 })
        .skip(skipNumber)
        .limit(limitNumber)
        .lean(),
      messageModel.countDocuments({ conversation: conversationId }),
    ]);

    res.status(200).json({
      code: messages.SUCCESSFULLY.code,
      message: messages.SUCCESSFULLY.message,
      data: {
        messages: items,
        pagination: { skip: skipNumber, limit: limitNumber, total },
      },
    });
  } catch (error) {
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
  }
};

export { getMessagesAdmin };
