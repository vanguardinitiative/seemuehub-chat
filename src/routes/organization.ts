import { Router, type Request, type Response } from "express";
import { checkAuthorizationMiddleware } from "@/middleware";
import { messages, withErrorCode } from "@/config";
import { isObjectIdString } from "@/utils/ids";
import {
  OrgChatRefusal,
  getConversation,
  listConversations,
  listMessages,
  openConversation,
  readAsOrganization,
  sendAsOrganization,
} from "@/services/org-chat";

/**
 * A company's side of its conversations with candidates
 * (worktrees/ORG-CHAT-CONTRACT.md §3.2; the rules are src/services/org-chat.ts).
 * Answers `{ success, data }`, or `{ success: false, errors: { code, message } }`
 * as these routes always did: `errors.code` is always the specific code.
 */
const router = Router();
const uid = (req: Request) => String((req as any).user?.userId ?? (req as any).user?.id);

const fail = (res: Response, status: number, code: string, message?: string) =>
  void res.status(status).json({ success: false, errors: { code, ...(message ? { message } : {}) } });

/** A refusal as its status and code; anything else is the 500 these routes always gave. */
const handle = (res: Response, error: unknown, what: string) => {
  if (error instanceof OrgChatRefusal) {
    // The message-type and sticker refusals keep the CHAT-400 fields these
    // routes always had, with the envelope's own two beside them.
    if (error.code === "INVALID_MESSAGE_TYPE" || error.code === "INVALID_STICKER") {
      return void res.status(400).json({ success: false, ...withErrorCode(messages[error.code], error.code) });
    }
    return fail(res, error.status, error.code, error.message);
  }
  console.error(`${what} failed`, error instanceof Error ? error.message : error);
  fail(res, 500, "INTERNAL_EXCEPTION", "Something went wrong");
};

router.use(checkAuthorizationMiddleware);

/** The company inbox: newest first, each conversation with `unread` for the company. */
router.get("/:id/conversations", async (req: Request, res: Response) => {
  try {
    if (!isObjectIdString(req.params.id)) return fail(res, 400, "VALIDATION_ERROR", "Invalid organization id");
    const skip = Math.max(0, Number(req.query.skip ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50) || 50));
    res.json({ success: true, data: await listConversations(String(req.params.id), uid(req), skip, limit) });
  } catch (error) {
    handle(res, error, "organization conversation list");
  }
});

/**
 * Open a conversation with a candidate, with the company's first message:
 * 201 when it is new, 200 when it was already there (the message goes into
 * it). Body: { candidateUserId, basis, applicationId?, matchId?, firstMessage }.
 */
router.post("/:id/conversations", async (req: Request, res: Response) => {
  try {
    if (!isObjectIdString(req.params.id)) return fail(res, 400, "VALIDATION_ERROR", "Invalid organization id");
    const { status, conversation, message } = await openConversation(String(req.params.id), uid(req), req.body);
    res.status(status).json({ success: true, data: { conversation, message } });
  } catch (error) {
    handle(res, error, "organization conversation open");
  }
});

/** One company conversation, in the shape of an inbox item. */
router.get("/conversations/:conversationId", async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getConversation(String(req.params.conversationId), uid(req)) });
  } catch (error) {
    handle(res, error, "organization conversation read");
  }
});

/** The company's view of a conversation's messages, newest first (?before, ?skip, ?limit). */
router.get("/conversations/:conversationId/messages", async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listMessages(String(req.params.conversationId), uid(req), req.query as Record<string, unknown>) });
  } catch (error) {
    handle(res, error, "organization message list");
  }
});

/** A member answers for the company. */
router.post("/conversations/:conversationId/messages", async (req: Request, res: Response) => {
  try {
    const message = await sendAsOrganization(String(req.params.conversationId), uid(req), req.body ?? {});
    res.status(201).json({ success: true, data: message });
  } catch (error) {
    handle(res, error, "organization message send");
  }
});

/** The company has read the conversation up to now. */
router.put("/conversations/:conversationId/read", async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await readAsOrganization(String(req.params.conversationId), uid(req)) });
  } catch (error) {
    handle(res, error, "organization read");
  }
});

export default router;
