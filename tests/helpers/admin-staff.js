/**
 * Staff RBAC fixtures for the admin oversight endpoints
 * (worktrees/ADMIN-RBAC-CONTRACT.md §8): the `users`, `adminroles` and
 * `adminaccessstate` reads and the `adminauditlogs` writes, in memory.
 *
 * Require ./offline first. Not a test file.
 */
const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");
const { stub } = require("./offline");

const { userModel } = require("../../dist/models/user.js");
const { adminRoleModel, adminAuditLogModel, adminAccessStateModel } = require("../../dist/models/admin-access.js");
const { forgetBootstrapMarker } = require("../../dist/services/admin-access.js");

const oid = () => new Types.ObjectId().toString();

/**
 * The system role rows the backend's sync writes. Their stored permissions are
 * left empty on purpose: a system role's permissions come from code, so the
 * tests pass only if the chat service reads them from its mirror.
 */
const SYSTEM_ROLE_IDS = Object.freeze({
  SUPER_ADMIN: oid(),
  OPERATIONS: oid(),
  SUPPORT: oid(),
  MODERATOR: oid(),
  FINANCE: oid(),
  MARKETING: oid(),
  AUDITOR: oid(),
});
const systemRoleRows = () =>
  Object.entries(SYSTEM_ROLE_IDS).map(([key, id]) => ({ _id: new Types.ObjectId(id), key, system: true, permissions: [] }));

/** A role id: a system key's row, or the id itself (a custom role). */
const roleId = (role) => new Types.ObjectId(SYSTEM_ROLE_IDS[role] ?? role);

/** A stored ADMIN account with a staff record; `roles` are system keys or custom role ids. */
const staffUser = ({
  id = oid(),
  roles = ["SUPER_ADMIN"],
  status = "ACTIVE",
  sessionVersion = 0,
  mfa = false,
  sessionsRevokedAt,
  email = "staff@seemuehub.test",
} = {}) => ({
  _id: new Types.ObjectId(id),
  role: "ADMIN",
  email,
  staff: {
    status,
    roleIds: roles.map(roleId),
    sessionVersion,
    ...(sessionsRevokedAt ? { sessionsRevokedAt } : {}),
    mfa: { enabled: mfa },
  },
});

/** A resolved query that records what was selected. */
const chain = (result, selects) => {
  const query = {
    then: (resolve, reject) => Promise.resolve().then(result).then(resolve, reject),
    lean: () => query,
    select: (fields) => {
      selects.push(fields);
      return query;
    },
  };
  return query;
};

/**
 * Installs the stubs. `users` maps an id to the stored user (anyone else is a
 * plain USER); `roles` adds custom role rows; `bootstrapped` is whether the
 * backend's bootstrap marker exists. `fail` names the reads/writes that throw:
 * "users", "roles", "marker", "audit".
 */
const staffWorld = ({ users = {}, roles = [], bootstrapped = true, fail = [], auditWrite } = {}) => {
  forgetBootstrapMarker();
  const audit = [];
  const reads = { users: 0, roles: 0, marker: 0, userSelects: [] };
  const rows = [...systemRoleRows(), ...roles];
  const restores = [
    stub(userModel, "findById", (id) => {
      reads.users++;
      return chain(() => {
        if (fail.includes("users")) throw new Error("users down");
        return users[String(id)] ?? { _id: new Types.ObjectId(String(id)), role: "USER", email: "user@seemuehub.test" };
      }, reads.userSelects);
    }),
    stub(adminRoleModel, "find", (filter) => {
      reads.roles++;
      return chain(() => {
        if (fail.includes("roles")) throw new Error("adminroles down");
        const ids = (filter?._id?.$in ?? []).map(String);
        return rows.filter((row) => ids.includes(String(row._id)));
      }, []);
    }),
    stub(adminAccessStateModel, "findById", (id) => {
      reads.marker++;
      return chain(() => {
        if (fail.includes("marker")) throw new Error("adminaccessstate down");
        return bootstrapped && id === "staff-bootstrap" ? { _id: id } : null;
      }, []);
    }),
    stub(adminAuditLogModel, "create", async (row) => {
      if (auditWrite) return auditWrite(row);
      if (fail.includes("audit")) throw new Error("adminauditlogs down");
      // Through the real schema: what would be stored, cast and validated.
      const doc = new adminAuditLogModel(row);
      const invalid = doc.validateSync();
      if (invalid) throw invalid;
      audit.push(doc.toObject());
      return doc;
    }),
  ];
  return {
    audit,
    reads,
    restore: () => {
      for (const restore of restores.reverse()) restore();
      forgetBootstrapMarker();
    },
  };
};

/** One ACTIVE, not-yet-enrolled SUPER_ADMIN at `id`: what the existing route tests' admin is now. */
const asSuperAdmin = (id) => staffWorld({ users: { [id]: staffUser({ id }) } });

// ---------------------------------------------------------------- tokens

const secret = () => process.env.JWT_SECRET_KEY;
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** What /auth/login, Google, Apple, register-or-login mint: `{ userId }`. */
const plainToken = (userId, claims = {}, options = { expiresIn: "1h" }) => jwt.sign({ userId, ...claims }, secret(), options);

/** An admin access token (password + TOTP): `{ userId, aud: 'admin', sv, amr, authAt }`, 15 minutes. */
const adminToken = (userId, { sv = 0, amr = ["pwd", "otp"], authAt = nowSeconds() } = {}) =>
  jwt.sign({ userId, aud: "admin", sv, amr, authAt }, secret(), { expiresIn: 900 });

/** The admin refresh token: `type: 'refresh'`, never an access token. */
const adminRefreshToken = (userId, sv = 0) =>
  jwt.sign({ userId, type: "refresh", aud: "admin", sv, authAt: nowSeconds() }, secret(), { expiresIn: 3600 });

/** The MFA challenge and enrolment tokens: `sub`, no `userId`. */
const challengeToken = (userId, sv = 0) => jwt.sign({ sub: userId, aud: "admin-mfa", sv }, secret(), { expiresIn: 300 });
const enrolmentToken = (userId, sv = 0) => jwt.sign({ sub: userId, aud: "admin-enroll", sv }, secret(), { expiresIn: 900 });

module.exports = {
  SYSTEM_ROLE_IDS,
  oid,
  staffUser,
  staffWorld,
  asSuperAdmin,
  plainToken,
  adminToken,
  adminRefreshToken,
  challengeToken,
  enrolmentToken,
};
