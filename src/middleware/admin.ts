import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";

import { messages } from "@/config";
import { userModel, UserRole } from "@/models/user";

/**
 * Admin oversight guard.
 *
 * Seemuehub admins need to read any conversation in order to monitor abuse and
 * mediate disputes. That is a real requirement, but it is also the one thing
 * `utils/conversation-access.ts` deliberately makes impossible for ordinary
 * callers, so it gets an explicit, separate gate rather than a loosened filter
 * on the normal handlers.
 *
 * The main API signs `{ userId }` and carries no role claim, so the role is
 * read from the shared `users` collection rather than trusted from the token.
 * Run this *after* `checkAuthorizationMiddleware`, which puts the caller on the
 * request.
 */
export const requireAdminMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?.userId;

    if (typeof userId !== "string" || !Types.ObjectId.isValid(userId)) {
      res.status(401).json(messages.UNAUTHORIZED);
      return;
    }

    const user = await userModel.findById(userId).select("role").lean();

    if (!user || user.role !== UserRole.ADMIN) {
      // Deliberately the same shape as any other refusal: an oversight
      // endpoint should not confirm its own existence to a non-admin.
      console.warn("[access] admin oversight refused", { userId });
      res.status(403).json(messages.FORBIDDEN);
      return;
    }

    next();
  } catch (error) {
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
  }
};
