import type { Request, Response } from "express";
import { Types } from "mongoose";

import { messages } from "@/config";
import { conversationModel } from "@/models/conversation";
import { userModel } from "@/models/user";

/**
 * Oversight listing: every conversation on the platform.
 *
 * This is `getAllConversions` without the `participants.user` filter — the one
 * difference that matters — so it lives behind `requireAdminMiddleware` rather
 * than sharing a handler with the member-facing endpoint. Keeping them apart
 * means no future edit can accidentally widen the member query.
 *
 * Read-only by design: admins mediate through the disputes queue in the main
 * API, which has real release/refund actions and records who decided.
 */
const getAllConversationsAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { search, skip = "0", limit = "50", orderStatus } = req.query as Record<string, string>;
    const skipNumber = Number.parseInt(skip, 10) || 0;
    const limitNumber = Math.min(Number.parseInt(limit, 10) || 50, 100);

    const query: Record<string, unknown> = {};

    if (orderStatus) {
      query.orderStatus = orderStatus;
    }

    if (search?.trim()) {
      const term = { $regex: search.trim(), $options: "i" };
      const matchedUsers = await userModel
        .find({ $or: [{ displayName: term }, { userName: term }, { email: term }] }, { _id: 1 })
        .lean<Array<{ _id: Types.ObjectId }>>();

      query.$or = [
        { conversationName: term },
        { orderTitle: term },
        { "participants.user": { $in: matchedUsers.map((user) => user._id) } },
      ];
    }

    const [conversations, total] = await Promise.all([
      conversationModel
        .find(query)
        .populate("participants.user", "userName displayName email profileImage isFreelancer")
        .sort({ updatedAt: -1 })
        .skip(skipNumber)
        .limit(limitNumber)
        .lean(),
      conversationModel.countDocuments(query),
    ]);

    res.status(200).json({
      code: messages.SUCCESSFULLY.code,
      message: messages.SUCCESSFULLY.message,
      data: {
        conversations,
        pagination: {
          skip: skipNumber,
          limit: limitNumber,
          total,
        },
      },
    });
  } catch (error) {
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
  }
};

export { getAllConversationsAdmin };
