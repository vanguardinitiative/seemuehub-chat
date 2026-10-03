import { IRouter, Router } from "express";
import { messages, withErrorCode } from "@/config";
import { env } from "@/config/env";
import { requireInternalKey } from "@/middleware/internal-key";
import { AgentMessageRefusal, postAgentMessage } from "@/services/agent-messages";

const agentMessageRoute: IRouter = Router();

/** `{ success: false, errors: { code, message } }`, the backend's envelope (AGENT-CONTRACT.md "Rules for every repo"). */
const refused = (code: string, message: string) => ({ success: false, errors: { code, message } });

// seemuehub-backend only: a Seemue AI card posted into a chat on a
// participant's request (AGENT-CONTRACT.md §8.2, src/services/agent-messages.ts).
// Fail closed: with no CHAT_INTERNAL_KEY configured, nobody gets in.
agentMessageRoute.post(
  "/",
  requireInternalKey(() => env.CHAT_INTERNAL_KEY, {
    failClosed: true,
    body: { success: false, ...withErrorCode(messages.UNAUTHORIZED, "UNAUTHORIZED") },
  }),
  async (req, res) => {
    try {
      const { message } = await postAgentMessage(req.body);
      res.status(201).json({ success: true, data: { message } });
    } catch (error) {
      if (error instanceof AgentMessageRefusal) return void res.status(error.status).json(refused(error.code, error.message));
      console.error("agent message failed", error instanceof Error ? error.message : error);
      res.status(500).json(refused("INTERNAL_EXCEPTION", "Something went wrong"));
    }
  }
);

export default agentMessageRoute;
