import { AGENT_MESSAGE_KINDS, type AgentMessageKind } from "@/models/message";
import { isObjectIdString } from "@/utils/ids";

/**
 * POST /agent-messages' body (worktrees/AGENT-CONTRACT.md §8.2), as pure
 * functions: what seemuehub-backend may post, and what is stored from it.
 * No Mongo, no Redis.
 *
 *   { conversationId, requestedBy, content, agent: { v: 1, kind, card, threadId?, actionId?, requestedBy? } }
 *
 * The card is a §4 card. Only its common fields are checked here
 * (`type`, `v`, `id`, `fallbackText`); the rest is the backend's, stored as
 * sent, and rendered by type on new clients. Old clients show `content`.
 */

/** `content`, in characters (code points), once trimmed. */
export const AGENT_CONTENT_MAX = 2000;
/** A card's `fallbackText`, in characters, once trimmed. */
export const AGENT_FALLBACK_MAX = 2000;
/**
 * A card as JSON, in UTF-16 units. Lao is 3 bytes a character in UTF-8, so
 * this keeps a whole request under express.json's 100 kB default.
 */
export const AGENT_CARD_MAX_CHARS = 24_000;
/** How deep a card may nest. */
export const AGENT_CARD_MAX_DEPTH = 12;

/** A thread or action id from the backend: an ObjectId, a UUID or a slug, never anything that is not an id. */
const AGENT_REF = /^[A-Za-z0-9_-]{1,64}$/;
/** A §4 card type: UPPER_SNAKE (BRIEF, AGREEMENT, DELIVERY_CHECKLIST, ...). */
const CARD_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface AgentMessageInput {
  conversationId: string;
  requestedBy: string;
  content: string;
  agent: {
    v: 1;
    kind: AgentMessageKind;
    card: Record<string, unknown>;
    threadId?: string;
    actionId?: string;
  };
}

export type AgentMessageParse = { ok: true; value: AgentMessageInput } | { ok: false; field: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const characters = (text: string): number => Array.from(text).length;

/** A trimmed, non-empty string of at most `max` characters, or null. */
const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && characters(trimmed) <= max ? trimmed : null;
};

/**
 * Whether a card is plain JSON that is safe to store as is: no key that
 * Mongo or JavaScript reads as more than a name (`$…`, `__proto__`), and no
 * deeper than AGENT_CARD_MAX_DEPTH.
 */
const safeJson = (value: unknown, depth = 0): boolean => {
  if (depth > AGENT_CARD_MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => safeJson(item, depth + 1));
  if (value === null || typeof value !== "object") return true;
  return Object.keys(value).every(
    (key) => !key.startsWith("$") && key !== "__proto__" && safeJson((value as Record<string, unknown>)[key], depth + 1)
  );
};

/** Why a card is refused (the field named in the 400), or null when it passes. */
export const cardProblem = (card: unknown): string | null => {
  if (!isPlainObject(card)) return "agent.card";
  if (typeof card.type !== "string" || !CARD_TYPE.test(card.type)) return "agent.card.type";
  if (typeof card.v !== "number" || !Number.isInteger(card.v) || card.v < 1) return "agent.card.v";
  if (text(card.id, 128) === null) return "agent.card.id";
  if (text(card.fallbackText, AGENT_FALLBACK_MAX) === null) return "agent.card.fallbackText";
  if (!safeJson(card)) return "agent.card";
  let json: string;
  try {
    json = JSON.stringify(card);
  } catch {
    return "agent.card";
  }
  if (json.length > AGENT_CARD_MAX_CHARS) return "agent.card";
  return null;
};

const optionalRef = (value: unknown): { ok: true; value?: string } | { ok: false } => {
  if (value === undefined || value === null) return { ok: true };
  return typeof value === "string" && AGENT_REF.test(value) ? { ok: true, value } : { ok: false };
};

/**
 * The body, or the first field that is wrong. `agent.requestedBy` is the
 * service's own (it is always `requestedBy`); one that is sent must agree.
 */
export const parseAgentMessageBody = (body: unknown): AgentMessageParse => {
  const input = isPlainObject(body) ? body : {};
  if (!isObjectIdString(input.conversationId)) return { ok: false, field: "conversationId" };
  if (!isObjectIdString(input.requestedBy)) return { ok: false, field: "requestedBy" };
  const requestedBy = input.requestedBy.toLowerCase();

  const content = text(input.content, AGENT_CONTENT_MAX);
  if (content === null) return { ok: false, field: "content" };

  const agent = input.agent;
  if (!isPlainObject(agent)) return { ok: false, field: "agent" };
  if (agent.v !== 1) return { ok: false, field: "agent.v" };
  if (!(AGENT_MESSAGE_KINDS as readonly unknown[]).includes(agent.kind)) return { ok: false, field: "agent.kind" };
  const problem = cardProblem(agent.card);
  if (problem) return { ok: false, field: problem };
  const threadId = optionalRef(agent.threadId);
  if (!threadId.ok) return { ok: false, field: "agent.threadId" };
  const actionId = optionalRef(agent.actionId);
  if (!actionId.ok) return { ok: false, field: "agent.actionId" };
  if (agent.requestedBy !== undefined && agent.requestedBy !== null) {
    if (typeof agent.requestedBy !== "string" || agent.requestedBy.toLowerCase() !== requestedBy) {
      return { ok: false, field: "agent.requestedBy" };
    }
  }

  return {
    ok: true,
    value: {
      conversationId: input.conversationId.toLowerCase(),
      requestedBy,
      content,
      agent: {
        v: 1,
        kind: agent.kind as AgentMessageKind,
        card: agent.card as Record<string, unknown>,
        ...(threadId.value ? { threadId: threadId.value } : {}),
        ...(actionId.value ? { actionId: actionId.value } : {}),
      },
    },
  };
};
