import { Types } from "mongoose";

import { env } from "@/config/env";
import {
  BOOTSTRAP_MARKER_ID,
  adminAccessStateModel,
  adminAuditLogModel,
  adminRoleModel,
  type AdminRoleRow,
} from "@/models/admin-access";
import { WILDCARD_PERMISSION, systemRolePermissions } from "@/utils/admin-system-roles";
import { idString, isObjectIdString } from "@/utils/ids";

/**
 * Who may use the admin oversight endpoints (worktrees/ADMIN-RBAC-CONTRACT.md
 * §4, §8). The same rules as the backend's resolveSessionContext
 * (src/modules/admin-access/admin-session.ts there), for one question: may
 * this token, on this account, use `permission` here?
 *
 *  1. An admin token (`aud: "admin"`, password + TOTP): the account must be
 *     ADMIN, its staff record ACTIVE, the token's `sv` its sessionVersion, and
 *     `amr` must include "otp". Otherwise 401 ADMIN_SESSION_REQUIRED.
 *  2. A plain token (no `aud`) on an ADMIN account:
 *     - issued before staff.sessionsRevokedAt: 401, whatever the flag;
 *     - ADMIN_SESSION_ENFORCED=true: 401, only admin tokens count;
 *     - no staff record: SUPER_ADMIN until the backend's staff bootstrap has
 *       run (the `adminaccessstate` marker), 401 after it. `staff: null` is
 *       never a staff record;
 *     - SUSPENDED or INVITED: 401;
 *     - an enrolled member (`staff.mfa.enabled`): 401. Their admin power is
 *       reached through password + TOTP only;
 *     - otherwise the member's own roles. The transition never widens them.
 *  3. Anyone else: 403 FORBIDDEN, as before - an ordinary user is not an
 *     expired admin, and the oversight endpoints do not describe themselves
 *     to one.
 *
 * Once a session counts, its roles must grant the permission, else 403
 * ADMIN_PERMISSION_REQUIRED: never a 401, so the admin client keeps the
 * session of a member who lacks one permission. With the flag on, an admin
 * token whose account has no authenticator enrolled is refused too.
 */

export const ADMIN_AUDIENCE = "admin";

/** The permission the oversight endpoints need. */
export const CHATS_READ = "chats.read";

export const adminSessionEnforced = (): boolean => env.ADMIN_SESSION_ENFORCED === "true";

/**
 * What is read of the user. Named paths only: the stored staff record also
 * holds the TOTP secret, recovery-code hashes and the invite token hash, and a
 * `staff` projection would bring them all along.
 */
export const ADMIN_USER_PROJECTION =
  "role email staff.status staff.roleIds staff.sessionVersion staff.sessionsRevokedAt staff.mfa.enabled";

export type StaffRecord = {
  status?: string | null;
  roleIds?: readonly unknown[] | null;
  sessionVersion?: number | null;
  sessionsRevokedAt?: Date | string | null;
  mfa?: { enabled?: boolean | null } | null;
};

export type AdminCaller = { _id: unknown; role?: string | null; email?: string | null; staff?: StaffRecord | null };

/** The verified token's claims the decision reads. */
export type AdminTokenClaims = { aud?: unknown; sv?: unknown; amr?: unknown; iat?: unknown };

/**
 * A plain token issued before the account's sessions were revoked (suspend,
 * MFA reset, "sign out everywhere", a password change). Plain tokens carry no
 * `sv`, so their issue time is compared instead, in whole seconds as JWT `iat`
 * is. A token without `iat` counts as revoked. Same as the backend.
 */
export const plainTokenRevoked = (iat: unknown, revokedAt: Date | string | null | undefined): boolean => {
  if (!revokedAt) return false;
  const revokedSecond = Math.floor(new Date(revokedAt).getTime() / 1000);
  if (!Number.isFinite(revokedSecond)) return false;
  return typeof iat !== "number" || iat < revokedSecond;
};

// ---------------------------------------------------------------------------
// Roles

export type ResolvedRoles = {
  /** System role keys; a custom role appears as its id. */
  roleKeys: string[];
  permissions: ReadonlySet<string>;
  /** A system role with `*`: every permission. */
  superAdmin: boolean;
};

/**
 * One role's keys. A system role's come from the code (utils/admin-system-roles.ts),
 * not from its stored row, so a hand edit to the database cannot widen it.
 * `*` counts on a system role only: a custom role that somehow holds it gets
 * nothing from it.
 */
const keysOf = (row: AdminRoleRow): { keys: readonly string[]; wildcard: boolean } => {
  const fromCode = row.system ? systemRolePermissions(row.key) : undefined;
  if (fromCode) return { keys: fromCode, wildcard: fromCode.includes(WILDCARD_PERMISSION) };
  return { keys: (row.permissions ?? []).filter((key) => key !== WILDCARD_PERMISSION), wildcard: false };
};

/** The union of the rows' permissions. */
export const resolveRoles = (rows: readonly AdminRoleRow[]): ResolvedRoles => {
  const permissions = new Set<string>();
  const roleKeys: string[] = [];
  let superAdmin = false;
  for (const row of rows) {
    const { keys, wildcard } = keysOf(row);
    if (wildcard) superAdmin = true;
    for (const key of keys) if (typeof key === "string") permissions.add(key);
    roleKeys.push(row.system && row.key ? row.key : String(idString(row._id)));
  }
  return { roleKeys, permissions, superAdmin };
};

export const grants = (resolved: ResolvedRoles, permission: string): boolean =>
  resolved.superAdmin || resolved.permissions.has(permission);

/**
 * The staff member's roles, read every time: the oversight endpoints are
 * rare, and a role edit or removal then applies to the very next request.
 */
export const loadRoles = async (roleIds: readonly unknown[]): Promise<AdminRoleRow[]> => {
  const ids = [...new Set(roleIds.map((id) => idString(id)).filter(isObjectIdString))];
  if (ids.length === 0) return [];
  return adminRoleModel.find({ _id: { $in: ids } }).select("key permissions system").lean<AdminRoleRow[]>();
};

// ---------------------------------------------------------------------------
// The bootstrap marker

/**
 * Has the backend's `staff:bootstrap --apply` run? It writes
 * `adminaccessstate { _id: "staff-bootstrap" }` as its last step, after giving
 * every ADMIN a staff record; from then on an ADMIN without one is an anomaly,
 * not a pre-RBAC admin, and gets nothing.
 *
 * The marker only ever goes from unset to set, so a set value is kept for the
 * life of the process and an unset one re-read at most every 30 seconds. A
 * failed read throws: neither "grant" nor "refuse" is a safe guess, so the
 * caller answers 503.
 */
export const BOOTSTRAP_RECHECK_MS = 30_000;
let marker: { bootstrapped: boolean; checkedAt: number } | null = null;

export const isAdminBootstrapped = async (now: number = Date.now()): Promise<boolean> => {
  if (marker?.bootstrapped) return true;
  if (marker && now - marker.checkedAt < BOOTSTRAP_RECHECK_MS) return false;
  const row = await adminAccessStateModel.findById(BOOTSTRAP_MARKER_ID).select("_id").lean();
  marker = { bootstrapped: !!row, checkedAt: now };
  return marker.bootstrapped;
};

/** Forget what the marker said (tests). */
export const forgetBootstrapMarker = (): void => {
  marker = null;
};

// ---------------------------------------------------------------------------
// The decision

export type AdminRefusalCode = "ADMIN_SESSION_REQUIRED" | "ADMIN_PERMISSION_REQUIRED" | "FORBIDDEN";

export type AdminAccessDecision =
  | { allowed: true; roleKeys: string[]; session: "admin" | "legacy" }
  | { allowed: false; status: 401 | 403; code: AdminRefusalCode; reason: string };

const sessionRequired = (reason: string): AdminAccessDecision => ({
  allowed: false,
  status: 401,
  code: "ADMIN_SESSION_REQUIRED",
  reason,
});

const forbidden = (reason: string): AdminAccessDecision => ({ allowed: false, status: 403, code: "FORBIDDEN", reason });

const byRoles = async (
  roleIds: readonly unknown[] | null | undefined,
  permission: string,
  session: "admin" | "legacy"
): Promise<AdminAccessDecision> => {
  const resolved = resolveRoles(await loadRoles(roleIds ?? []));
  if (!grants(resolved, permission)) {
    return { allowed: false, status: 403, code: "ADMIN_PERMISSION_REQUIRED", reason: "permission_missing" };
  }
  return { allowed: true, roleKeys: resolved.roleKeys, session };
};

/**
 * May `claims` (a verified access token) on `user` (as read with
 * ADMIN_USER_PROJECTION; null when there is none) use `permission`? Throws
 * when the roles or the bootstrap marker cannot be read.
 */
export const decideAdminAccess = async (
  claims: AdminTokenClaims,
  user: AdminCaller | null,
  permission: string,
  options: { enforced?: boolean } = {}
): Promise<AdminAccessDecision> => {
  const enforced = options.enforced ?? adminSessionEnforced();
  const adminAccount = user?.role === "ADMIN";
  const staff = user?.staff ?? null;

  // Rule 1: an admin token, which only a staff sign-in mints.
  if (claims.aud === ADMIN_AUDIENCE) {
    const amr = Array.isArray(claims.amr) ? claims.amr : [];
    const valid =
      adminAccount &&
      staff?.status === "ACTIVE" &&
      typeof claims.sv === "number" &&
      claims.sv === (staff.sessionVersion ?? 0) &&
      amr.includes("otp");
    if (!valid) return sessionRequired("admin_token_invalid");
    if (enforced && staff!.mfa?.enabled !== true) return sessionRequired("mfa_not_enrolled");
    return byRoles(staff!.roleIds, permission, "admin");
  }

  // Rule 3: an ordinary account.
  if (!user || !adminAccount) return forbidden("not_admin");

  // A token of any other audience is not a session at all (the MFA challenge
  // and enrolment tokens have one; they also carry no userId, so they never
  // get this far).
  if (claims.aud !== undefined) return sessionRequired("foreign_audience");

  // Rule 2: a plain token on an ADMIN account.
  if (staff && plainTokenRevoked(claims.iat, staff.sessionsRevokedAt)) return sessionRequired("plain_token_revoked");
  if (enforced) return sessionRequired("plain_token_enforced");

  if (!staff) {
    // `staff: null` is no staff record, whatever else is true. (Through the
    // named-path projection a null record may read as absent; after the
    // bootstrap the two are refused alike, so that no longer matters.)
    if (user.staff === null) return sessionRequired("staff_null");
    if (await isAdminBootstrapped()) return sessionRequired("no_staff_after_bootstrap");
    // Before the bootstrap: every ADMIN keeps the power it had.
    return { allowed: true, roleKeys: ["SUPER_ADMIN"], session: "legacy" };
  }
  // A suspended or not-yet-activated member has no admin power.
  if (staff.status !== "ACTIVE") return sessionRequired("staff_inactive");
  // Enrolled: admin power only through password + TOTP.
  if (staff.mfa?.enabled === true) return sessionRequired("plain_token_enrolled");

  return byRoles(staff.roleIds, permission, "legacy");
};

// ---------------------------------------------------------------------------
// The audit log

/** One `adminauditlogs` row, in the backend's shape (ADMIN-RBAC-CONTRACT.md §7). */
export type AdminAuditRow = {
  at: Date;
  event: "HTTP";
  actorId?: Types.ObjectId;
  actorEmail?: string;
  actorRoleKeys?: string[];
  method?: string;
  route?: string;
  path?: string;
  query?: Record<string, unknown>;
  status?: number;
  permission?: string;
  targetType?: string;
  targetId?: string;
  requestId?: string;
  ip?: string;
  country?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
};

/** Append one row. The only write this service makes to the collection. */
export const writeAdminAuditRow = (row: AdminAuditRow): Promise<unknown> =>
  Promise.resolve().then(() => adminAuditLogModel.create(row));
