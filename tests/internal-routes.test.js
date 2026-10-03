/**
 * The REST holes closed on top of socket auth, against the compiled dist/ with
 * no Redis and no Mongo (tests/helpers/offline.js): npm test
 *
 * - POST /orders and POST /core-socket/payment are seemuehub-backend's; they
 *   require X-Internal-Key once CHAT_INTERNAL_KEY is set.
 * - PUT /message-status/read is for the conversation's participants only
 *   (the read itself: read-state.test.js).
 * - SYSTEM and ORDER_* are the service's own message types; REST refuses them.
 * - The boot log shows where Redis is, never its password.
 */
const { published, stub, query } = require("./helpers/offline");

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");

const { env } = require("../dist/config/env.js");
const router = require("../dist/routes/index.js").default;
const { internalKeyMatches } = require("../dist/middleware/internal-key.js");
const { conversationModel } = require("../dist/models/conversation.js");
const { messageModel } = require("../dist/models/message.js");
const { describeRedisConfig } = require("../dist/config/redis-log.js");

const oid = () => new Types.ObjectId().toString();
const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET_KEY, { expiresIn: "1h" });

/** The JSON warnings (internal_key_unset / _refused) printed while a test runs. */
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("{")) {
    try {
      warnings.push(JSON.parse(args[0]));
      return;
    } catch {}
  }
  originalWarn(...args);
};

const app = express();
app.use(express.json());
app.use("/v1/api", router);

const listen = () => new Promise((resolve) => { const server = app.listen(0, () => resolve(server)); });
const request = (port, method, url, { headers = {}, body } = {}) =>
  new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        port,
        path: url,
        method,
        headers: { ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}), ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
      }
    );
    req.on("error", () => resolve({ status: 0, body: null }));
    if (payload) req.write(payload);
    req.end();
  });

const KEY = "test-chat-internal-key";
const withKey = (key) => {
  const previous = env.CHAT_INTERNAL_KEY;
  env.CHAT_INTERNAL_KEY = key;
  return () => {
    env.CHAT_INTERNAL_KEY = previous;
  };
};

// ---------------------------------------------------------------- internal routes

/** An order step as seemuehub-backend posts it, without an orderId so no message is stored. */
const orderStep = () => ({ _id: oid(), participants: [{ user: oid() }], latestMessageData: { orderStep: "SUBMITTED" } });
const paymentNotice = () => ({ _id: oid(), userId: oid(), type: "WALLET_TRANSACTION", status: "COMPLETED" });

const INTERNAL = [
  { url: "/v1/api/orders", channel: "ORDER", body: orderStep },
  { url: "/v1/api/core-socket/payment", channel: "PAYMENT", body: paymentNotice },
];

for (const route of INTERNAL) {
  test(`POST ${route.url} with CHAT_INTERNAL_KEY set`, async (t) => {
    const restore = withKey(KEY);
    const server = await listen();
    const { port } = server.address();

    await t.test("no X-Internal-Key: 401, nothing published", async () => {
      published.length = 0;
      const res = await request(port, "POST", route.url, { body: route.body() });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.code, "CHAT-401");
      assert.deepStrictEqual(published, []);
      assert.ok(warnings.some((w) => w.msg === "internal_key_refused" && w.path === route.url && w.presented === "none"));
    });

    await t.test("a wrong key: 401, nothing published", async () => {
      published.length = 0;
      const res = await request(port, "POST", route.url, { headers: { "X-Internal-Key": `${KEY}x` }, body: route.body() });
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(published, []);
    });

    await t.test("a user's access token is not the key", async () => {
      published.length = 0;
      const res = await request(port, "POST", route.url, {
        headers: { Authorization: `Bearer ${tokenFor(oid())}` },
        body: route.body(),
      });
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(published, []);
    });

    await t.test("the backend's key: accepted and published", async () => {
      published.length = 0;
      const body = route.body();
      const res = await request(port, "POST", route.url, { headers: { "X-Internal-Key": KEY }, body });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(published.map((p) => p.channel), [route.channel]);
      assert.strictEqual(published[0].message._id, body._id);
    });

    server.close();
    restore();
  });

  test(`POST ${route.url} while CHAT_INTERNAL_KEY is unset keeps today's behaviour, with a warning`, async () => {
    const restore = withKey(undefined);
    const server = await listen();
    published.length = 0;
    warnings.length = 0;

    const res = await request(server.address().port, "POST", route.url, { body: route.body() });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(published.map((p) => p.channel), [route.channel]);
    assert.deepStrictEqual(warnings, [{ msg: "internal_key_unset", path: route.url, action: "allowed" }]);

    server.close();
    restore();
  });
}

test("internalKeyMatches", async (t) => {
  await t.test("matches only the exact key", () => {
    assert.strictEqual(internalKeyMatches(KEY, KEY), true);
    assert.strictEqual(internalKeyMatches(`${KEY} `, KEY), false);
    assert.strictEqual(internalKeyMatches("", KEY), false);
  });

  await t.test("compares keys of different lengths without throwing (both sides are hashed)", () => {
    assert.strictEqual(internalKeyMatches("short", "a-much-longer-key-than-that"), false);
  });
});

// ---------------------------------------------------------------- read status

test("PUT /message-status/read", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const me = oid();
  const other = oid();
  const conversationId = oid();

  /**
   * The participant filter of each read (the read mark is one
   * findOneAndUpdate scoped to the caller, see read-state.test.js), and every
   * other write the handler made.
   */
  const lookups = [];
  const writes = [];
  const restores = [
    stub(conversationModel, "findOneAndUpdate", (filter) => {
      lookups.push(filter);
      const isMember = String(filter._id) === conversationId && String(filter["participants.user"]) === me;
      return query(
        isMember
          ? {
              _id: conversationId,
              conversationType: "PRIVATE",
              participants: [
                { user: new Types.ObjectId(me), userType: "USER", lastReadAt: new Date() },
                { user: new Types.ObjectId(other), userType: "USER" },
              ],
              // Already read by everyone: nothing more to mark.
              latestMessageData: { senderId: other, messageId: oid(), readAllAt: new Date() },
            }
          : null
      );
    }),
    stub(messageModel, "updateMany", async () => void writes.push("messages")),
    stub(conversationModel, "updateOne", async () => void writes.push("conversation")),
  ];
  const put = (id, token) =>
    request(port, "PUT", `/v1/api/message-status/read?conversationId=${id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  await t.test("without a token: 401 before anything is read", async () => {
    lookups.length = 0;
    assert.strictEqual((await put(conversationId)).status, 401);
    assert.deepStrictEqual(lookups, []);
  });

  await t.test("a malformed conversationId: 400, not a CastError 500", async () => {
    lookups.length = 0;
    assert.strictEqual((await put("not-an-id", tokenFor(me))).status, 400);
    assert.deepStrictEqual(lookups, []);
  });

  await t.test("someone who is not a participant: 404, and nothing is marked read", async () => {
    lookups.length = 0;
    const res = await put(conversationId, tokenFor(oid()));
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, "CHAT-404");
    assert.strictEqual(lookups.length, 1);
    assert.ok(lookups[0]["participants.user"], "the lookup is scoped to the caller");
    assert.deepStrictEqual(writes, []);
    assert.ok(!published.some((p) => p.channel === "READ_MESSAGE"));
  });

  await t.test("a participant: answered as before", async () => {
    published.length = 0;
    const res = await put(conversationId, tokenFor(me));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.code, "CHAT-200");
    assert.strictEqual(res.body.data.conversationId, conversationId);
    assert.deepStrictEqual(writes, []);
    const notices = published.filter((p) => p.channel === "READ_MESSAGE");
    assert.deepStrictEqual(notices.map((p) => p.message.userIds), [[me]], "only the reader's own devices");
  });

  for (const restore of restores) restore();
  server.close();
});

// ---------------------------------------------------------------- message types over REST

test("REST message sends refuse the service's own message types", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const token = tokenFor(oid());
  const lookups = [];
  // POST /messages finds the conversation with the caller as a participant
  // (findOne), the organization route finds a company conversation (findOne);
  // a sendAsOrganizationId send reads it by id. Any of them is "a read".
  const restores = ["findById", "findOne"].map((method) =>
    stub(conversationModel, method, (filter) => {
      lookups.push(filter);
      return query(null);
    })
  );
  const restore = () => restores.forEach((undo) => undo());

  const cases = [
    ["POST /messages", "/v1/api/messages", { conversationId: oid(), body: "hi" }],
    ["POST /organizations/conversations/:id/messages", `/v1/api/organizations/conversations/${oid()}/messages`, { body: "hi" }],
  ];
  for (const [label, url, body] of cases) {
    for (const messageType of ["SYSTEM", "ORDER_STATUS_CHANGE", "ORDER_PAYMENT", "NOT_A_TYPE"]) {
      await t.test(`${label} with messageType ${messageType}: 400 before anything is read`, async () => {
        lookups.length = 0;
        const res = await request(port, "POST", url, { headers: { Authorization: `Bearer ${token}` }, body: { ...body, messageType } });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.message, "Invalid message type");
        assert.deepStrictEqual(lookups, []);
      });
    }

    await t.test(`${label} without a messageType goes on as before`, async () => {
      lookups.length = 0;
      const res = await request(port, "POST", url, { headers: { Authorization: `Bearer ${token}` }, body });
      // The stubbed conversation does not exist.
      assert.strictEqual(res.status, 404);
      assert.strictEqual(lookups.length, 1);
    });
  }

  restore();
  server.close();
});

// ---------------------------------------------------------------- boot log

test("the Redis boot log", async (t) => {
  await t.test("describeRedisConfig keeps host and port and drops the password", () => {
    const described = describeRedisConfig({ socket: { host: "redis.internal", port: 6380 }, password: "hunter2", database: 0 });
    assert.deepStrictEqual(described, { host: "redis.internal", port: 6380 });
    assert.ok(!JSON.stringify(described).includes("hunter2"));
  });

  await t.test("config/redis logs the description, never the config object itself", () => {
    const source = fs.readFileSync(path.join(__dirname, "../dist/config/redis.js"), "utf8");
    assert.match(source, /describeRedisConfig\)?\(redisConfig\)/);
    assert.doesNotMatch(source, /console\.\w+\([^()]*\bredisConfig\s*\)/);
  });
});
