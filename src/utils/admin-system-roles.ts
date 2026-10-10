/**
 * The backend's preset staff roles, mirrored (ADMIN-RBAC-CONTRACT.md §2).
 *
 * Source of truth: seemuehub-backend `src/modules/admin-access/system-roles.ts`.
 * Change this file when that one changes; the keys and lists below are a copy.
 *
 * Why a copy: a system role's permissions come from code, not from its row in
 * `adminroles`. The backend overwrites those rows from its own table at every
 * boot, so a hand edit in the database cannot widen a system role, and its
 * permission check reads the table, not the row. This service does the same
 * with this table, so the two agree on what OPERATIONS or MODERATOR may do
 * even if a row was edited by hand between two backend deploys.
 *
 * Only `chats.read` matters here today. A system role this table does not know
 * (one the backend added later) falls back to its stored permissions, as an
 * unknown system key does in the backend; `*` is never honoured from a row.
 */

/** "Every key, including ones added later": SUPER_ADMIN's whole list. */
export const WILDCARD_PERMISSION = "*";

export const SYSTEM_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SUPER_ADMIN: [WILDCARD_PERMISSION],
  OPERATIONS: [
    "dashboard.read",
    "users.read",
    "users.write",
    "users.devices.read",
    "kyc.read",
    "kyc.review",
    "account_deletions.read",
    "account_deletions.process",
    "organizations.read",
    "organizations.review",
    "jobs.read",
    "jobs.moderate",
    "gigs.read",
    "gigs.moderate",
    "categories.write",
    "matching.read",
    "orders.read",
    "orders.status_override",
    "disputes.read",
    "finance.read",
    "loyalty.read",
    "loyalty.redemptions.process",
    "progression.read",
    "progression.subjects.manage",
    "chats.read",
    "feedback.read",
    "feedback.respond",
    "whatsapp.read",
    "whatsapp.send",
    "push.read",
    "broadcast.read",
    "reports.read",
    "ai.read",
    "settings.read",
    "uploads.manage",
  ],
  SUPPORT: [
    "dashboard.read",
    "users.read",
    "users.devices.read",
    "kyc.read",
    "account_deletions.read",
    "organizations.read",
    "jobs.read",
    "gigs.read",
    "orders.read",
    "disputes.read",
    "finance.read",
    "loyalty.read",
    "progression.read",
    "feedback.read",
    "feedback.respond",
    "whatsapp.read",
    "whatsapp.send",
  ],
  MODERATOR: [
    "dashboard.read",
    "users.read",
    "kyc.read",
    "kyc.review",
    "organizations.read",
    "organizations.review",
    "jobs.read",
    "jobs.moderate",
    "gigs.read",
    "gigs.moderate",
    "categories.write",
    "ads.write",
    "feedback.read",
    "chats.read",
    "uploads.manage",
  ],
  FINANCE: [
    "dashboard.read",
    "users.read",
    "finance.read",
    "withdrawals.process",
    "orders.read",
    "orders.escrow_release",
    "disputes.read",
    "disputes.resolve",
    "packages.write",
    "loyalty.read",
    "loyalty.points.adjust",
    "loyalty.redemptions.process",
    "reports.read",
    "settings.read",
    "settings.fees.write",
    "settings.billing.write",
  ],
  MARKETING: [
    "dashboard.read",
    "reports.read",
    "push.read",
    "push.write",
    "push.send",
    "broadcast.read",
    "broadcast.send",
    "ads.write",
    "stickers.write",
    "loyalty.read",
    "loyalty.configure",
    "progression.read",
    "progression.configure",
    "content.translate",
  ],
  AUDITOR: [
    "dashboard.read",
    "users.read",
    "account_deletions.read",
    "organizations.read",
    "jobs.read",
    "gigs.read",
    "matching.read",
    "orders.read",
    "disputes.read",
    "finance.read",
    "loyalty.read",
    "progression.read",
    "push.read",
    "broadcast.read",
    "feedback.read",
    "reports.read",
    "ai.read",
    "settings.read",
    "staff.read",
    "audit.read",
  ],
});

/** The code's permission list for a system role key, or undefined for a key this table does not know. */
export const systemRolePermissions = (key: unknown): readonly string[] | undefined =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(SYSTEM_ROLE_PERMISSIONS, key)
    ? SYSTEM_ROLE_PERMISSIONS[key]
    : undefined;
