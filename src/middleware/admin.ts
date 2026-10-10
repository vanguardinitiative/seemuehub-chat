import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";

import { messages, withErrorCode } from "@/config";
import { userModel } from "@/models/user";
import {
  ADMIN_USER_PROJECTION,
  CHATS_READ,
  decideAdminAccess,
  writeAdminAuditRow,
  type AdminAuditRow,
  type AdminCaller,
} from "@/services/admin-access";

/**
 * Admin oversight guard.
 *
 * Seemuehub admins need to read any conversation in order to monitor abuse and
 * mediate disputes. That is a real requirement, but it is also the one thing
 * `utils/conversation-access.ts` deliberately makes impossible for ordinary
 * callers, so it gets an explicit, separate gate rather than a loosened filter
 * on the normal handlers.
 *
 * It used to be one check, the stored role ADMIN, so any token for an admin
 * account - a Google sign-in on the consumer app included - could read every
 * chat. Now it follows the backend's staff RBAC (ADMIN-RBAC-CONTRACT.md §8):
 * the session must count as a staff session and the member's roles must grant
 * the permission. The rules are in services/admin-access.ts.
 *
 * The answers:
 * - 401 ADMIN_SESSION_REQUIRED: an admin account whose token is not a staff
 *   session (bad admin token, suspended, revoked, enrolled but signed in
 *   without TOTP, no staff record, a plain token while enforced);
 * - 403 ADMIN_PERMISSION_REQUIRED, `errors.permission`: a staff session whose
 *   roles lack the permission;
 * - 403 FORBIDDEN: anyone else, the same body as before, so the endpoint does
 *   not describe itself to a non-admin;
 * - 503 ADMIN_ACCESS_UNAVAILABLE: the user, roles or bootstrap marker could
 *   not be read. Never a 401 for that: a database blip must not end anyone's
 *   session.
 * These are REST answers only. The socket handshake does not read staff
 * records, so none of this disconnects or signs anybody out of chat.
 *
 * Every allowed request leaves one `adminauditlogs` row (event HTTP), written
 * once the response has gone out, never awaited by it.
 *
 * Run this *after* `checkAuthorizationMiddleware`, which verifies the token
 * and puts its claims on the request.
 */

type RefusalKey = "ADMIN_SESSION_REQUIRED" | "ADMIN_PERMISSION_REQUIRED" | "ADMIN_ACCESS_UNAVAILABLE";

/** `{ success: false, code: "CHAT-4xx", message, errors: { code, message, ...extra } }`. */
const refusal = (key: RefusalKey, extra: Record<string, string> = {}) => {
  const body = withErrorCode(messages[key], key);
  return { success: false, ...body, errors: { ...body.errors, ...extra } };
};

// ---------------------------------------------------------------------------
// The audit row

/** The API prefix routes/index.ts is mounted under; the row's `route` leaves it out, as the backend's do. */
const API_PREFIX = /^\/v1\/api(?=\/|$)/;
/** Query keys whose values never reach the log (ADMIN-RBAC-CONTRACT.md §7). */
const SECRET_KEY = /password|token|secret|code|otp|recovery/i;
const MAX_TEXT = 256;

const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof first === "string" ? first.trim() : "";
  return trimmed ? trimmed : undefined;
};

/** Where the request came from, in the backend's order (rate-limit.ts clientAddress). */
const clientAddress = (req: Request): string | undefined =>
  (header(req, "cf-connecting-ip") ??
    header(req, "x-forwarded-for")?.split(",")[0]?.trim() ??
    header(req, "x-real-ip") ??
    req.socket?.remoteAddress ??
    undefined)?.slice(0, 64) || undefined;

/** The query as the row keeps it: strings only, capped, secrets redacted. */
const auditQuery = (query: unknown): Record<string, unknown> | undefined => {
  if (!query || typeof query !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) out[key] = "[REDACTED]";
    else if (typeof value === "string") out[key] = value.slice(0, MAX_TEXT);
    else if (Array.isArray(value)) out[key] = value.filter((v) => typeof v === "string").slice(0, 10).map((v) => v.slice(0, MAX_TEXT));
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * The row for an allowed request. Built before the handler runs, while
 * `baseUrl` and `route` are this route's (Express moves them about as it
 * routes); `status` is filled in once the response is out.
 */
export const buildAdminAuditRow = (
  req: Request,
  caller: AdminCaller,
  details: { permission: string; roleKeys: string[]; session: "admin" | "legacy" }
): AdminAuditRow => {
  const route = req.route?.path ? `${req.baseUrl}${req.route.path}`.replace(API_PREFIX, "") || "/" : undefined;
  const conversationId = typeof req.query?.conversationId === "string" ? req.query.conversationId : undefined;
  const country = header(req, "cf-ipcountry");
  const actorId = String(caller._id);
  return {
    at: new Date(),
    event: "HTTP",
    actorId: Types.ObjectId.isValid(actorId) ? new Types.ObjectId(actorId) : undefined,
    actorEmail: typeof caller.email === "string" ? caller.email : undefined,
    actorRoleKeys: details.roleKeys,
    method: req.method,
    route,
    path: `${req.baseUrl}${req.path}`,
    query: auditQuery(req.query),
    permission: details.permission,
    // The transcript read is about one conversation; the listing about none.
    targetType: conversationId ? "conversations" : undefined,
    targetId: conversationId?.slice(0, 64),
    requestId: header(req, "x-request-id")?.slice(0, 128),
    ip: clientAddress(req),
    country: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : undefined,
    userAgent: header(req, "user-agent")?.slice(0, MAX_TEXT),
    // Which service wrote the row, and whether a plain (pre-TOTP) token was
    // used: what tells the owner when ADMIN_SESSION_ENFORCED can be turned on.
    metadata: { service: "chat", session: details.session },
  };
};

// ---------------------------------------------------------------------------
// The guard

export const requireAdminPermission =
  (permission: string) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const claims = ((req as any).user ?? {}) as Record<string, unknown>;
    const userId = claims.userId;

    // checkAuthorizationMiddleware already refuses a token without a usable
    // userId - the MFA challenge and enrolment tokens carry only `sub` - so
    // this is the second lock on that door.
    if (typeof userId !== "string" || !Types.ObjectId.isValid(userId)) {
      res.status(401).json(messages.UNAUTHORIZED);
      return;
    }

    let caller: AdminCaller | null;
    let decision: Awaited<ReturnType<typeof decideAdminAccess>>;
    try {
      caller = (await userModel.findById(userId).select(ADMIN_USER_PROJECTION).lean()) as AdminCaller | null;
      decision = await decideAdminAccess(claims, caller, permission);
    } catch (error) {
      console.error("[access] admin access could not be checked", {
        userId,
        reason: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json(refusal("ADMIN_ACCESS_UNAVAILABLE"));
      return;
    }

    if (!decision.allowed) {
      console.warn("[access] admin oversight refused", { userId, reason: decision.reason, path: req.path });
      if (decision.code === "ADMIN_PERMISSION_REQUIRED") {
        res.status(403).json(refusal("ADMIN_PERMISSION_REQUIRED", { permission }));
      } else if (decision.code === "ADMIN_SESSION_REQUIRED") {
        res.status(401).json(refusal("ADMIN_SESSION_REQUIRED"));
      } else {
        // Deliberately the same shape as any other refusal: an oversight
        // endpoint should not confirm its own existence to a non-admin.
        res.status(403).json(messages.FORBIDDEN);
      }
      return;
    }

    let row: AdminAuditRow | null = null;
    try {
      row = buildAdminAuditRow(req, caller!, { permission, roleKeys: decision.roleKeys, session: decision.session });
    } catch (error) {
      console.error("[admin-audit] row not built", { userId, reason: error instanceof Error ? error.message : String(error) });
    }
    // Written after the response, so the row has its status and the reader
    // does not wait for the write. A failed write is logged, never answered:
    // an audit outage must not become an oversight outage.
    if (row) {
      const pending = row;
      res.once("close", () => {
        pending.status = res.statusCode;
        void writeAdminAuditRow(pending).catch((error) => {
          console.error("[admin-audit] row not written", {
            userId,
            method: pending.method,
            path: pending.path,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
      });
    }

    next();
  };

/** GET /conversations/admin and GET /messages/admin: reading anyone's chats. */
export const requireAdminMiddleware = requireAdminPermission(CHATS_READ);
