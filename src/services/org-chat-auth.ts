import axios from "axios";
import { env } from "@/config/env";
import { cache as redisCache } from "@/config/redis";

/**
 * Who may chat for an organization, asked of seemuehub-backend
 * (worktrees/ORG-CHAT-CONTRACT.md §2.2-2.3).
 *
 * The backend owns organizations, memberships, roles and the proofs a company
 * needs to contact a candidate, so before this service opens a company
 * conversation, or lets a member list, read or answer one, it asks
 * `POST {BACKEND_URL}/api/v1/internal/org-chat/authorize` with the shared
 * CHAT_INTERNAL_KEY. The backend answers 200 with `allow` and, when it is
 * false, a `code`.
 *
 * - LIST, READ and SEND are one rule (the member's role and the tenant's
 *   status), so one answer per organization and member is kept in Redis for
 *   60 s (`orgchat:auth:{orgId}:{userId}`), refusals included.
 * - OPEN is never cached: it proves a basis about one candidate and checks
 *   the daily cap, which change from one call to the next.
 * - The backend unreachable, slow (2 s), unconfigured or answering something
 *   else is OrgChatUnavailableError: the callers fail closed (503).
 */

export const ORG_CHAT_INTERNAL_PATH = "/api/v1/internal/org-chat";
export const ORG_CHAT_AUTH_TIMEOUT_MS = 2_000;
export const ORG_CHAT_AUTH_CACHE_SECONDS = 60;

export type OrgChatAction = "OPEN" | "SEND" | "READ" | "LIST";

export interface AuthorizeInput {
  action: OrgChatAction;
  organizationId: string;
  actorUserId: string;
  candidateUserId?: string;
  basis?: string;
  applicationId?: string;
  matchId?: string;
}

/** What the conversation snapshots and pushes are titled with. */
export interface OrgChatOrganization {
  _id: string;
  name: string;
  nameLao?: string;
  logo?: string;
  slug: string;
}

export interface AuthorizeResult {
  allow: boolean;
  code?: string;
  basis?: string;
  jobId?: string;
  organization: OrgChatOrganization | null;
  remainingToday?: number;
}

/** The backend could not be asked, or did not answer with a decision. */
export class OrgChatUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "OrgChatUnavailableError";
  }
}

export interface OrgChatAuthDeps {
  /** Read per call: the configuration as it is now. */
  config: () => { backendUrl?: string; internalKey?: string };
  post: (url: string, body: unknown, options: { timeout: number; headers: Record<string, string> }) => Promise<{ data?: unknown }>;
  cache: { get: (key: string) => Promise<string | null>; set: (key: string, value: string, ttlSeconds: number) => Promise<void> };
}

const defaultDeps: OrgChatAuthDeps = {
  config: () => ({ backendUrl: env.BACKEND_URL, internalKey: env.CHAT_INTERNAL_KEY }),
  post: (url, body, options) => axios.post(url, body, options),
  // Looked up per call, so a test's stand-in for config/redis is the one used.
  cache: {
    get: async (key) => redisCache.get(key),
    set: async (key, value, ttlSeconds) => redisCache.set(key, value, ttlSeconds),
  },
};

/** One answer per organization and member for LIST, READ and SEND (contract §3.2). */
export const authCacheKey = (organizationId: string, userId: string) =>
  `orgchat:auth:${organizationId.toLowerCase()}:${userId.toLowerCase()}`;

const asResult = (data: unknown): AuthorizeResult | null => {
  if (!data || typeof data !== "object" || typeof (data as { allow?: unknown }).allow !== "boolean") return null;
  const value = data as AuthorizeResult;
  return { ...value, organization: value.organization ?? null };
};

/** POST one internal route; the `data` of `{ success, data }`. Throws OrgChatUnavailableError for anything else. */
const call = async (route: string, body: unknown, deps: OrgChatAuthDeps): Promise<unknown> => {
  const { backendUrl, internalKey } = deps.config();
  if (!backendUrl || !internalKey) throw new OrgChatUnavailableError("BACKEND_URL or CHAT_INTERNAL_KEY is not set");
  const url = `${backendUrl.replace(/\/+$/, "")}${ORG_CHAT_INTERNAL_PATH}${route}`;
  try {
    const response = await deps.post(url, body, {
      timeout: ORG_CHAT_AUTH_TIMEOUT_MS,
      headers: { "X-Internal-Key": internalKey },
    });
    return (response?.data as { data?: unknown } | undefined)?.data;
  } catch (error) {
    // Ids and the status only, as chat_push_failed.
    const status = (error as { response?: { status?: number } })?.response?.status ?? null;
    const code = (error as { code?: string })?.code ?? null;
    console.warn(JSON.stringify({ msg: "org_chat_backend_failed", route, status, code }));
    throw new OrgChatUnavailableError(`backend ${route} failed`);
  }
};

/**
 * The backend's decision for `input`. LIST, READ and SEND come from the
 * cache when they can; OPEN always asks.
 */
export const authorizeOrgChat = async (input: AuthorizeInput, deps: OrgChatAuthDeps = defaultDeps): Promise<AuthorizeResult> => {
  const cacheable = input.action !== "OPEN";
  const key = authCacheKey(input.organizationId, input.actorUserId);
  if (cacheable) {
    const hit = await deps.cache.get(key).catch(() => null);
    if (hit) {
      try {
        const cached = asResult(JSON.parse(hit));
        if (cached) return cached;
      } catch {
        // A value this did not write: ask the backend instead.
      }
    }
  }

  const result = asResult(await call("/authorize", input, deps));
  if (!result) throw new OrgChatUnavailableError("backend answered without a decision");
  if (cacheable) await deps.cache.set(key, JSON.stringify(result), ORG_CHAT_AUTH_CACHE_SECONDS).catch(() => {});
  return result;
};

/**
 * Tell the backend a conversation was really created, which is what the
 * daily cap counts. Best effort: a conversation that exists is not undone
 * because the counter could not be told. Resolves to what is left today, or
 * null.
 */
export const reportOpened = async (organizationId: string, deps: OrgChatAuthDeps = defaultDeps): Promise<number | null> => {
  try {
    const data = (await call("/opened", { organizationId }, deps)) as { remainingToday?: unknown } | undefined;
    return typeof data?.remainingToday === "number" ? data.remainingToday : null;
  } catch {
    return null;
  }
};

/**
 * Record the candidate's block with the backend, so eligibility and every
 * later OPEN refuse the company. Resolves to whether the backend has it; the
 * block on the conversation itself holds either way, and a repeated block
 * call (idempotent on both sides) tells the backend again.
 */
export const reportBlock = async (
  block: { userId: string; organizationId: string; conversationId: string },
  deps: OrgChatAuthDeps = defaultDeps
): Promise<boolean> => {
  try {
    const data = (await call("/blocks", block, deps)) as { blocked?: unknown } | undefined;
    return data?.blocked === true;
  } catch {
    return false;
  }
};
