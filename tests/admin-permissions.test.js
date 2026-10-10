/**
 * Staff RBAC on the admin oversight endpoints (worktrees/ADMIN-RBAC-CONTRACT.md
 * §4, §7, §8): GET /conversations/admin and GET /messages/admin, against the
 * compiled dist/ with no Redis and no Mongo (tests/helpers/offline.js and
 * tests/helpers/admin-staff.js): npm test
 */
const { stub, query } = require("./helpers/offline");
const {
  SYSTEM_ROLE_IDS,
  oid,
  staffUser,
  staffWorld,
  plainToken,
  adminToken,
  adminRefreshToken,
  challengeToken,
  enrolmentToken,
} = require("./helpers/admin-staff");

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");

const { env } = require("../dist/config/env.js");
const router = require("../dist/routes/index.js").default;
const { conversationModel } = require("../dist/models/conversation.js");
const { messageModel } = require("../dist/models/message.js");
const { verifyAccessToken, AccessTokenError } = require("../dist/utils/access-token.js");
const { SYSTEM_ROLE_PERMISSIONS } = require("../dist/utils/admin-system-roles.js");
const { isAdminBootstrapped, forgetBootstrapMarker, BOOTSTRAP_RECHECK_MS } = require("../dist/services/admin-access.js");
const { adminAccessStateModel } = require("../dist/models/admin-access.js");

// ---------------------------------------------------------------- harness

/** The refusal and audit-failure lines, kept out of the test output. */
const logs = { warn: [], error: [] };
const originalWarn = console.warn;
const originalError = console.error;
console.warn = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("[access]")) return void logs.warn.push(args);
  originalWarn(...args);
};
console.error = (...args) => {
  if (typeof args[0] === "string" && (args[0].startsWith("[access]") || args[0].startsWith("[admin-audit]")))
    return void logs.error.push(args);
  originalError(...args);
};

const app = express();
app.use(express.json());
app.use("/v1/api", router);

let server;
let port;
test.before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  port = server.address().port;
});
test.after(() => server.close());

const get = (url, { token, headers = {} } = {}) =>
  new Promise((resolve) => {
    const req = http.request(
      { port, path: url, method: "GET", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
      }
    );
    req.on("error", () => resolve({ status: 0, body: null }));
    req.end();
  });

const CONVERSATION = oid();
const LIST = "/v1/api/conversations/admin";
const TRANSCRIPT = `/v1/api/messages/admin?conversationId=${CONVERSATION}`;

/** What the two handlers read once the guard lets a request through. */
const stubHandlers = () => {
  const restores = [
    stub(conversationModel, "find", () => query([])),
    stub(conversationModel, "countDocuments", () => query(0)),
    stub(conversationModel, "findById", () => query({ _id: CONVERSATION })),
    stub(messageModel, "find", () => query([])),
    stub(messageModel, "countDocuments", () => query(0)),
  ];
  return () => restores.reverse().forEach((restore) => restore());
};

const withFlag = (value) => {
  const previous = env.ADMIN_SESSION_ENFORCED;
  env.ADMIN_SESSION_ENFORCED = value;
  return () => {
    env.ADMIN_SESSION_ENFORCED = previous;
  };
};

/**
 * Runs `fn` with the handlers stubbed, the flag at `flag` and `world`
 * installed; restores everything after.
 */
const scenario = async ({ flag = "false", ...world } = {}, fn) => {
  const handlers = stubHandlers();
  const restoreFlag = withFlag(flag);
  const installed = staffWorld(world);
  try {
    return await fn(installed);
  } finally {
    installed.restore();
    restoreFlag();
    handlers();
  }
};

/** Waits for the audit rows written after the response (they are not awaited by it). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const assertSessionRequired = (res, why) => {
  assert.strictEqual(res.status, 401, why);
  assert.strictEqual(res.body.errors?.code, "ADMIN_SESSION_REQUIRED", why);
  assert.strictEqual(res.body.code, "CHAT-401");
};

const assertPermissionRequired = (res, why) => {
  assert.strictEqual(res.status, 403, why);
  assert.strictEqual(res.body.errors?.code, "ADMIN_PERMISSION_REQUIRED", why);
  assert.strictEqual(res.body.errors?.permission, "chats.read", why);
  assert.strictEqual(res.body.code, "CHAT-403");
};

const ADMIN = oid();

// ---------------------------------------------------------------- token type

test("tokens that are not sessions never reach the staff check", async (t) => {
  await t.test("an MFA challenge token (sub, no userId) is 401 on both endpoints; nothing is read", async () => {
    await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN }) } }, async (world) => {
      for (const url of [LIST, TRANSCRIPT]) {
        const res = await get(url, { token: challengeToken(ADMIN) });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.code, "CHAT-401");
        assert.strictEqual(res.body.errors.code, "UNAUTHORIZED");
      }
      assert.strictEqual(world.reads.users, 0);
      await settle();
      assert.strictEqual(world.audit.length, 0);
    });
  });

  await t.test("an MFA enrolment token is 401 too", async () => {
    await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN }) } }, async (world) => {
      assert.strictEqual((await get(LIST, { token: enrolmentToken(ADMIN) })).status, 401);
      assert.strictEqual(world.reads.users, 0);
    });
  });

  await t.test("an admin refresh token is not an access token", async () => {
    await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN, mfa: true }) } }, async (world) => {
      assert.strictEqual((await get(LIST, { token: adminRefreshToken(ADMIN) })).status, 401);
      assert.strictEqual(world.reads.users, 0);
    });
  });

  await t.test("the check the socket handshake shares refuses the challenge and enrolment tokens", () => {
    for (const token of [challengeToken(ADMIN), enrolmentToken(ADMIN)]) {
      assert.throws(() => verifyAccessToken(token), (error) => error instanceof AccessTokenError && error.code === "TOKEN_INVALID");
    }
  });

  await t.test("and still accepts a staff member's plain and admin tokens: RBAC never signs anyone out of chat", () => {
    assert.strictEqual(verifyAccessToken(plainToken(ADMIN)).userId, ADMIN);
    assert.strictEqual(verifyAccessToken(adminToken(ADMIN)).userId, ADMIN);
  });
});

// ---------------------------------------------------------------- roles (flag off)

test("the roles must grant chats.read (flag off)", async (t) => {
  const cases = [
    [["SUPER_ADMIN"], 200],
    [["OPERATIONS"], 200],
    [["MODERATOR"], 200],
    [["SUPPORT"], 403],
    [["FINANCE"], 403],
    [["MARKETING"], 403],
    [["AUDITOR"], 403],
    [["SUPPORT", "MODERATOR"], 200],
    [[], 403],
  ];
  for (const [roles, status] of cases) {
    await t.test(`${roles.join(" + ") || "no roles"}: ${status}`, async () => {
      await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN, roles }) } }, async () => {
        for (const url of [LIST, TRANSCRIPT]) {
          const res = await get(url, { token: plainToken(ADMIN) });
          if (status === 200) assert.strictEqual(res.status, 200, url);
          else assertPermissionRequired(res, url);
        }
      });
    });
  }

  await t.test("SUPER_ADMIN through an admin token as well", async () => {
    await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN, mfa: true }) } }, async () => {
      assert.strictEqual((await get(TRANSCRIPT, { token: adminToken(ADMIN) })).status, 200);
    });
  });

  await t.test("a role without chats.read is refused through an admin token too, with 403 not 401", async () => {
    await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN, roles: ["FINANCE"], mfa: true }) } }, async () => {
      assertPermissionRequired(await get(LIST, { token: adminToken(ADMIN) }));
    });
  });

  await t.test("a custom role grants what is ticked on it", async () => {
    const reader = { _id: new Types.ObjectId(), name: { lo: "ອ່ານແຊັດ" }, system: false, permissions: ["chats.read"] };
    const other = { _id: new Types.ObjectId(), name: { lo: "ອື່ນ" }, system: false, permissions: ["users.read"] };
    await scenario(
      {
        roles: [reader, other],
        users: { [ADMIN]: staffUser({ id: ADMIN, roles: [String(reader._id)] }) },
      },
      async (world) => {
        assert.strictEqual((await get(LIST, { token: plainToken(ADMIN) })).status, 200);
        await settle();
        assert.deepStrictEqual(world.audit[0].actorRoleKeys, [String(reader._id)], "a custom role is logged by its id");
      }
    );
    const OTHER = oid();
    await scenario({ roles: [other], users: { [OTHER]: staffUser({ id: OTHER, roles: [String(other._id)] }) } }, async () => {
      assertPermissionRequired(await get(LIST, { token: plainToken(OTHER) }));
    });
  });

  await t.test("* on a custom role grants nothing", async () => {
    const wildcard = { _id: new Types.ObjectId(), system: false, permissions: ["*"] };
    await scenario({ roles: [wildcard], users: { [ADMIN]: staffUser({ id: ADMIN, roles: [String(wildcard._id)] }) } }, async () => {
      assertPermissionRequired(await get(LIST, { token: plainToken(ADMIN) }));
    });
  });

  await t.test("a system role's permissions come from code: a hand-edited row does not widen it", async () => {
    // The SUPPORT row, edited in the database to read chats.
    const SUPPORT = SYSTEM_ROLE_IDS.SUPPORT;
    await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN, roles: ["SUPPORT"] }) } }, async (world) => {
      const { adminRoleModel } = require("../dist/models/admin-access.js");
      const restore = stub(adminRoleModel, "find", () =>
        query([{ _id: new Types.ObjectId(SUPPORT), key: "SUPPORT", system: true, permissions: ["chats.read", "*"] }])
      );
      try {
        assertPermissionRequired(await get(LIST, { token: plainToken(ADMIN) }));
      } finally {
        restore();
      }
    });
  });

  await t.test("a system role this service does not know yet falls back to its stored list, without *", async () => {
    const newer = { _id: new Types.ObjectId(), key: "TRUST_AND_SAFETY", system: true, permissions: ["chats.read"] };
    const newerWildcard = { _id: new Types.ObjectId(), key: "SOMETHING_ELSE", system: true, permissions: ["*"] };
    const OTHER = oid();
    await scenario(
      {
        roles: [newer, newerWildcard],
        users: {
          [ADMIN]: staffUser({ id: ADMIN, roles: [String(newer._id)] }),
          [OTHER]: staffUser({ id: OTHER, roles: [String(newerWildcard._id)] }),
        },
      },
      async () => {
        assert.strictEqual((await get(LIST, { token: plainToken(ADMIN) })).status, 200);
        assertPermissionRequired(await get(LIST, { token: plainToken(OTHER) }));
      }
    );
  });

  await t.test("the mirror: SUPER_ADMIN is *, and only OPERATIONS and MODERATOR also read chats", () => {
    assert.deepStrictEqual(SYSTEM_ROLE_PERMISSIONS.SUPER_ADMIN, ["*"]);
    const readers = Object.entries(SYSTEM_ROLE_PERMISSIONS)
      .filter(([, keys]) => keys.includes("chats.read"))
      .map(([key]) => key);
    assert.deepStrictEqual(readers, ["OPERATIONS", "MODERATOR"]);
    assert.deepStrictEqual(Object.keys(SYSTEM_ROLE_PERMISSIONS), ["SUPER_ADMIN", "OPERATIONS", "SUPPORT", "MODERATOR", "FINANCE", "MARKETING", "AUDITOR"]);
  });
});

// ---------------------------------------------------------------- session rules (always)

test("session rules that hold whatever the flag", async (t) => {
  for (const flag of ["false", "true"]) {
    await t.test(`flag ${flag}: a plain token on an enrolled member gets nothing, Super Admin or not`, async () => {
      await scenario({ flag, users: { [ADMIN]: staffUser({ id: ADMIN, mfa: true }) } }, async (world) => {
        assertSessionRequired(await get(LIST, { token: plainToken(ADMIN) }));
        await settle();
        assert.strictEqual(world.audit.length, 0);
      });
    });

    await t.test(`flag ${flag}: SUSPENDED and INVITED are refused, plain token or admin token`, async () => {
      for (const status of ["SUSPENDED", "INVITED"]) {
        await scenario({ flag, users: { [ADMIN]: staffUser({ id: ADMIN, status, mfa: true }) } }, async () => {
          assertSessionRequired(await get(LIST, { token: adminToken(ADMIN) }), `${status}, admin token`);
        });
        await scenario({ flag, users: { [ADMIN]: staffUser({ id: ADMIN, status }) } }, async () => {
          assertSessionRequired(await get(LIST, { token: plainToken(ADMIN) }), `${status}, plain token`);
        });
      }
    });

    await t.test(`flag ${flag}: an ADMIN with no staff record is refused once the bootstrap marker exists`, async () => {
      const legacy = { _id: new Types.ObjectId(ADMIN), role: "ADMIN", email: "old@seemuehub.test" };
      await scenario({ flag, bootstrapped: true, users: { [ADMIN]: legacy } }, async () => {
        assertSessionRequired(await get(LIST, { token: plainToken(ADMIN) }));
        assertSessionRequired(await get(TRANSCRIPT, { token: plainToken(ADMIN) }));
      });
    });
  }

  await t.test("a plain token issued before staff.sessionsRevokedAt is refused; one issued after is not", async () => {
    const now = Math.floor(Date.now() / 1000);
    const revokedAt = new Date((now - 60) * 1000);
    await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN, sessionsRevokedAt: revokedAt }) } }, async () => {
      assertSessionRequired(await get(LIST, { token: plainToken(ADMIN, { iat: now - 120 }) }), "issued before");
      assert.strictEqual((await get(LIST, { token: plainToken(ADMIN, { iat: now - 30 }) })).status, 200, "issued after");
      const noIat = jwt.sign({ userId: ADMIN }, process.env.JWT_SECRET_KEY, { noTimestamp: true, expiresIn: "1h" });
      assertSessionRequired(await get(LIST, { token: noIat }), "no iat counts as revoked");
    });
  });

  await t.test("an admin token must match: ADMIN account, ACTIVE, sv, otp in amr", async () => {
    await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN, sessionVersion: 3, mfa: true }) } }, async () => {
      assert.strictEqual((await get(LIST, { token: adminToken(ADMIN, { sv: 3 }) })).status, 200);
      assertSessionRequired(await get(LIST, { token: adminToken(ADMIN, { sv: 2 }) }), "stale sv (revoked)");
      assertSessionRequired(await get(LIST, { token: adminToken(ADMIN, { sv: 3, amr: ["pwd"] }) }), "no otp");
      const noSv = jwt.sign({ userId: ADMIN, aud: "admin", amr: ["pwd", "otp"] }, process.env.JWT_SECRET_KEY, { expiresIn: 900 });
      assertSessionRequired(await get(LIST, { token: noSv }), "no sv");
    });
    const USER = oid();
    await scenario({}, async () => {
      assertSessionRequired(await get(LIST, { token: adminToken(USER) }), "an ordinary account with an admin token");
    });
  });

  await t.test("an ordinary user gets the same 403 as before, which says nothing about staff", async () => {
    await scenario({}, async (world) => {
      const res = await get(LIST, { token: plainToken(oid()) });
      assert.strictEqual(res.status, 403);
      assert.deepStrictEqual(res.body, { code: "CHAT-403", message: "Forbidden" });
      assert.strictEqual(world.reads.roles, 0);
    });
  });
});

// ---------------------------------------------------------------- the flag

test("ADMIN_SESSION_ENFORCED", async (t) => {
  await t.test("off: a not-yet-enrolled member's plain token works with their own roles", async () => {
    await scenario({ flag: "false", users: { [ADMIN]: staffUser({ id: ADMIN, roles: ["MODERATOR"] }) } }, async (world) => {
      assert.strictEqual((await get(LIST, { token: plainToken(ADMIN) })).status, 200);
      await settle();
      assert.deepStrictEqual(world.audit[0].metadata, { service: "chat", session: "legacy" });
    });
  });

  await t.test("on: the same plain token is 401", async () => {
    await scenario({ flag: "true", users: { [ADMIN]: staffUser({ id: ADMIN, roles: ["MODERATOR"] }) } }, async () => {
      assertSessionRequired(await get(LIST, { token: plainToken(ADMIN) }));
    });
  });

  await t.test("on: an admin token of an enrolled, ACTIVE member with chats.read works", async () => {
    await scenario({ flag: "true", users: { [ADMIN]: staffUser({ id: ADMIN, roles: ["OPERATIONS"], mfa: true }) } }, async (world) => {
      assert.strictEqual((await get(TRANSCRIPT, { token: adminToken(ADMIN) })).status, 200);
      await settle();
      assert.deepStrictEqual(world.audit[0].metadata, { service: "chat", session: "admin" });
    });
  });

  await t.test("on: an admin token is refused while the member has no authenticator enrolled", async () => {
    await scenario({ flag: "true", users: { [ADMIN]: staffUser({ id: ADMIN, mfa: false }) } }, async () => {
      assertSessionRequired(await get(LIST, { token: adminToken(ADMIN) }));
    });
  });

  await t.test("off: that same admin token is accepted (the flag is what adds the MFA check)", async () => {
    await scenario({ flag: "false", users: { [ADMIN]: staffUser({ id: ADMIN, mfa: false }) } }, async () => {
      assert.strictEqual((await get(LIST, { token: adminToken(ADMIN) })).status, 200);
    });
  });

  await t.test("on: an admin token still needs chats.read (403, not 401)", async () => {
    await scenario({ flag: "true", users: { [ADMIN]: staffUser({ id: ADMIN, roles: ["AUDITOR"], mfa: true }) } }, async () => {
      assertPermissionRequired(await get(LIST, { token: adminToken(ADMIN) }));
    });
  });

  await t.test("on: an ADMIN with no staff record is refused without reading the marker", async () => {
    const legacy = { _id: new Types.ObjectId(ADMIN), role: "ADMIN" };
    await scenario({ flag: "true", bootstrapped: false, users: { [ADMIN]: legacy } }, async (world) => {
      assertSessionRequired(await get(LIST, { token: plainToken(ADMIN) }));
      assert.strictEqual(world.reads.marker, 0);
    });
  });

  await t.test("the value: defaults to false, case and spaces ignored, anything else stops the service at boot", () => {
    const load = (value) =>
      spawnSync(process.execPath, ["-e", "process.stdout.write(require('./dist/config/env.js').env.ADMIN_SESSION_ENFORCED)"], {
        cwd: path.join(__dirname, ".."),
        env: {
          PATH: process.env.PATH,
          MONGODB_URI: "mongodb://127.0.0.1:1/x",
          REDIS_HOST: "x",
          REDIS_PORT: "1",
          REDIS_PASSWORD: "x",
          ...(value === undefined ? {} : { ADMIN_SESSION_ENFORCED: value }),
        },
        encoding: "utf8",
      });
    assert.strictEqual(load(undefined).stdout, "false");
    assert.strictEqual(load("").stdout, "false");
    assert.strictEqual(load(" TRUE ").stdout, "true");
    assert.strictEqual(load("false").stdout, "false");
    assert.notStrictEqual(load("yes").status, 0);
  });
});

// ---------------------------------------------------------------- legacy admins and the marker

test("ADMIN accounts with no staff record (flag off)", async (t) => {
  const legacy = () => ({ _id: new Types.ObjectId(ADMIN), role: "ADMIN", email: "old@seemuehub.test" });

  await t.test("before the bootstrap marker: they keep their power, logged as SUPER_ADMIN legacy", async () => {
    await scenario({ bootstrapped: false, users: { [ADMIN]: legacy() } }, async (world) => {
      assert.strictEqual((await get(LIST, { token: plainToken(ADMIN) })).status, 200);
      await settle();
      assert.deepStrictEqual(world.audit[0].actorRoleKeys, ["SUPER_ADMIN"]);
      assert.deepStrictEqual(world.audit[0].metadata, { service: "chat", session: "legacy" });
    });
  });

  await t.test("once the marker exists: refused", async () => {
    await scenario({ bootstrapped: true, users: { [ADMIN]: legacy() } }, async () => {
      assertSessionRequired(await get(LIST, { token: plainToken(ADMIN) }));
    });
  });

  await t.test("staff: null is never a staff record, marker or not", async () => {
    await scenario({ bootstrapped: false, users: { [ADMIN]: { ...legacy(), staff: null } } }, async () => {
      assertSessionRequired(await get(LIST, { token: plainToken(ADMIN) }));
    });
  });

  await t.test("a marker that cannot be read is 503, neither a grant nor a sign-out", async () => {
    await scenario({ fail: ["marker"], users: { [ADMIN]: legacy() } }, async () => {
      const res = await get(LIST, { token: plainToken(ADMIN) });
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.errors.code, "ADMIN_ACCESS_UNAVAILABLE");
    });
  });

  await t.test("a set marker is read once per process; an unset one again after 30 seconds", async () => {
    let reads = 0;
    let exists = false;
    const restore = stub(adminAccessStateModel, "findById", () => {
      reads++;
      return query(exists ? { _id: "staff-bootstrap" } : null);
    });
    forgetBootstrapMarker();
    try {
      const t0 = 1_000_000;
      assert.strictEqual(await isAdminBootstrapped(t0), false);
      assert.strictEqual(await isAdminBootstrapped(t0 + 1000), false);
      assert.strictEqual(reads, 1, "unset: not re-read within 30 s");
      exists = true;
      assert.strictEqual(await isAdminBootstrapped(t0 + BOOTSTRAP_RECHECK_MS), true);
      assert.strictEqual(reads, 2);
      exists = false;
      assert.strictEqual(await isAdminBootstrapped(t0 + 10 * BOOTSTRAP_RECHECK_MS), true, "set stays set");
      assert.strictEqual(reads, 2);
    } finally {
      restore();
      forgetBootstrapMarker();
    }
  });
});

// ---------------------------------------------------------------- reads that fail

test("a read that fails is 503 ADMIN_ACCESS_UNAVAILABLE, never 401", async (t) => {
  for (const what of ["users", "roles"]) {
    await t.test(what, async () => {
      await scenario({ fail: [what], users: { [ADMIN]: staffUser({ id: ADMIN }) } }, async (world) => {
        const res = await get(LIST, { token: plainToken(ADMIN) });
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.errors.code, "ADMIN_ACCESS_UNAVAILABLE");
        await settle();
        assert.strictEqual(world.audit.length, 0);
      });
    });
  }

  await t.test("the user is read by named staff paths, never the whole record (it holds the TOTP secret)", async () => {
    await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN }) } }, async (world) => {
      await get(LIST, { token: plainToken(ADMIN) });
      const [fields] = world.reads.userSelects;
      const paths = fields.split(/\s+/);
      assert.ok(!paths.includes("staff"), fields);
      for (const needed of ["role", "staff.status", "staff.roleIds", "staff.sessionVersion", "staff.sessionsRevokedAt", "staff.mfa.enabled"]) {
        assert.ok(paths.includes(needed), `${needed} in ${fields}`);
      }
      assert.ok(!paths.some((p) => /secret|recovery|invite/i.test(p)), fields);
    });
  });
});

// ---------------------------------------------------------------- the audit row

test("every allowed request leaves one adminauditlogs row", async (t) => {
  await t.test("GET /messages/admin: the row, as the backend's shape has it", async () => {
    await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN, roles: ["MODERATOR"], email: "mod@seemuehub.test", mfa: true }) } }, async (world) => {
      const res = await get(`${TRANSCRIPT}&limit=20&access_token=leak`, {
        token: adminToken(ADMIN),
        headers: {
          "cf-connecting-ip": "203.0.113.7",
          "x-forwarded-for": "198.51.100.1, 10.0.0.1",
          "cf-ipcountry": "la",
          "user-agent": "x".repeat(400),
          "x-request-id": "req-123",
        },
      });
      assert.strictEqual(res.status, 200);
      await settle();
      assert.strictEqual(world.audit.length, 1);
      const [row] = world.audit;
      assert.ok(row.at instanceof Date);
      assert.ok(row.actorId instanceof Types.ObjectId);
      assert.strictEqual(String(row.actorId), ADMIN);
      assert.strictEqual(row.event, "HTTP");
      assert.strictEqual(row.permission, "chats.read");
      assert.strictEqual(row.method, "GET");
      assert.strictEqual(row.path, "/v1/api/messages/admin");
      assert.strictEqual(row.route, "/messages/admin");
      assert.strictEqual(row.status, 200);
      assert.strictEqual(row.ip, "203.0.113.7");
      assert.strictEqual(row.country, "LA");
      assert.strictEqual(row.userAgent.length, 256);
      assert.strictEqual(row.requestId, "req-123");
      assert.strictEqual(row.actorEmail, "mod@seemuehub.test");
      assert.deepStrictEqual(row.actorRoleKeys, ["MODERATOR"]);
      assert.strictEqual(row.targetType, "conversations");
      assert.strictEqual(row.targetId, CONVERSATION);
      assert.deepStrictEqual(row.query, { conversationId: CONVERSATION, limit: "20", access_token: "[REDACTED]" });
      assert.deepStrictEqual(row.metadata, { service: "chat", session: "admin" });
      assert.ok(!("__v" in row), "no version key, as the backend's rows");
    });
  });

  await t.test("GET /conversations/admin: no target, x-forwarded-for's first hop, no request id", async () => {
    await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN }) } }, async (world) => {
      assert.strictEqual((await get(LIST, { token: plainToken(ADMIN), headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" } })).status, 200);
      await settle();
      const [row] = world.audit;
      assert.strictEqual(row.route, "/conversations/admin");
      assert.strictEqual(row.path, "/v1/api/conversations/admin");
      assert.strictEqual(row.ip, "198.51.100.1");
      assert.strictEqual(row.targetId, undefined);
      assert.strictEqual(row.requestId, undefined);
      assert.deepStrictEqual(row.actorRoleKeys, ["SUPER_ADMIN"]);
    });
  });

  await t.test("the row carries the status the handler answered with", async () => {
    await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN }) } }, async (world) => {
      assert.strictEqual((await get("/v1/api/messages/admin", { token: plainToken(ADMIN) })).status, 400);
      await settle();
      assert.strictEqual(world.audit.length, 1);
      assert.strictEqual(world.audit[0].status, 400);
    });
  });

  await t.test("refused requests write none", async () => {
    await scenario({ users: { [ADMIN]: staffUser({ id: ADMIN, roles: ["SUPPORT"] }) } }, async (world) => {
      assert.strictEqual((await get(LIST, { token: plainToken(ADMIN) })).status, 403);
      assert.strictEqual((await get(LIST, { token: plainToken(oid()) })).status, 403);
      await settle();
      assert.strictEqual(world.audit.length, 0);
    });
  });

  await t.test("a failed write is logged and the reader still gets the answer", async () => {
    logs.error.length = 0;
    await scenario({ fail: ["audit"], users: { [ADMIN]: staffUser({ id: ADMIN }) } }, async () => {
      assert.strictEqual((await get(LIST, { token: plainToken(ADMIN) })).status, 200);
      await settle();
      assert.ok(logs.error.some(([line]) => line === "[admin-audit] row not written"), "logged");
    });
  });

  await t.test("the response does not wait for the write", async () => {
    let started = 0;
    await scenario(
      { users: { [ADMIN]: staffUser({ id: ADMIN }) }, auditWrite: () => (started++, new Promise(() => {})) },
      async () => {
        assert.strictEqual((await get(LIST, { token: plainToken(ADMIN) })).status, 200);
        await settle();
        assert.strictEqual(started, 1, "the write was started, and never finished");
      }
    );
  });
});
