import type { Request, Response } from "express";
import { messages, withErrorCode } from "@/config";
import { userIdOf } from "@/utils/conversation-access";
import { isObjectIdString } from "@/utils/ids";
import { OrgChatRefusal, blockOrganization, muteConversation } from "@/services/org-chat";

/**
 * A participant's own switches on a conversation (worktrees/ORG-CHAT-CONTRACT.md
 * §3.2): mute, on any conversation, and block, on a company conversation, by
 * its candidate. They answer in the participant routes' shape, `{ code:
 * "CHAT-200", message, data }`; every refusal is the usual CHAT-4xx body plus
 * `errors: { code, message }`, so a client can tell ORG_CHAT_DISABLED from a
 * 404 by `errors.code` alone.
 */

const refuse = (res: Response, status: number, code: string, message: string) =>
  void res.status(status).json({ code: `CHAT-${status}`, message, errors: { code, message } });

const unauthorized = (res: Response) => void res.status(401).json(withErrorCode(messages.UNAUTHORIZED, "UNAUTHORIZED"));
const invalidId = (res: Response) => void res.status(400).json(withErrorCode(messages.INVALID_CONVERSATION_ID, "VALIDATION_ERROR"));

const handle = (res: Response, error: unknown, what: string) => {
  if (error instanceof OrgChatRefusal) {
    if (error.code === "CONVERSATION_NOT_FOUND") {
      return void res.status(404).json(withErrorCode(messages.CONVERSATION_NOT_FOUND, "CONVERSATION_NOT_FOUND"));
    }
    return refuse(res, error.status, error.code, error.message);
  }
  console.error(`${what} failed`, error instanceof Error ? error.message : error);
  res.status(500).json(withErrorCode(messages.INTERNAL_SERVER_ERROR, "INTERNAL_EXCEPTION"));
};

/** PUT /conversations/:id/mute { muted: boolean } */
export const muteConversationHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = userIdOf(req);
    if (!userId) return unauthorized(res);
    const conversationId = String(req.params.id);
    if (!isObjectIdString(conversationId)) return invalidId(res);
    if (typeof req.body?.muted !== "boolean") return refuse(res, 400, "VALIDATION_ERROR", "muted must be true or false");

    const data = await muteConversation(conversationId, userId, req.body.muted);
    res.status(200).json({ code: messages.UPDATE_SUCCESSFUL.code, message: messages.UPDATE_SUCCESSFUL.message, data });
  } catch (error) {
    handle(res, error, "mute");
  }
};

/** POST /conversations/:id/block: the candidate blocks the company, for good. */
export const blockOrganizationHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = userIdOf(req);
    if (!userId) return unauthorized(res);
    const conversationId = String(req.params.id);
    if (!isObjectIdString(conversationId)) return invalidId(res);

    const data = await blockOrganization(conversationId, userId);
    res.status(200).json({ code: messages.SUCCESSFULLY.code, message: messages.SUCCESSFULLY.message, data });
  } catch (error) {
    handle(res, error, "block");
  }
};
