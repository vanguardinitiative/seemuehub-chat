/**
 * Seemue AI cards in a chat (worktrees/AGENT-CONTRACT.md §8, C2), against the
 * compiled dist/ with no Redis, no Mongo and no backend
 * (tests/helpers/offline.js, tests/helpers/org-chat-fakes.js,
 * tests/helpers/socket-harness.js): npm test
 *
 * - POST /agent-messages is seemuehub-backend's: X-Internal-Key, fail closed.
 * - The body is checked before anything is read (400 VALIDATION_ERROR).
 * - A participant posts; a stranger is refused (403 NOT_PARTICIPANT); a
 *   company member posts through authorize SEND, as the company; a blocked
 *   company conversation takes nothing.
 * - Stored as an AGENT message from the requester; latestMessageData moves
 *   with updateOne (never .save()), SEND_MESSAGE goes out, no push.
 * - AGENT is server-only: clients cannot send it, cannot set `agent`, and
 *   cannot reply or react to one.
 * - The message lists (participant, company, admin) and the conversation list
 *   show it as stored.
 */
const { published, cached, stub, query } = require("./helpers/offline");
const { installBackend, installStore, oid } = require("./helpers/org-chat-fakes");
const harness = require("./helpers/socket-harness");
const { collect, logged, nextEvent, settle, until } = harness;

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");

const router = require("../dist/routes/index.js").default;
const { env } = require("../dist/config/env.js");
const { conversationModel } = require("../dist/models/conversation.js");
const { messageModel, MessageType } = require("../dist/models/message.js");
const { messageStatusModel } = require("../dist/models/messageStatus.js");
const { userModel } = require("../dist/models/user.js");
const { CLIENT_MESSAGE_TYPES, isClientMessageType, isServerMessageType } = require("../dist/utils/message-type.js");
const { reactionTargetProblem, applyReaction } = require("../dist/utils/reactions.js");
const { replyDropReason } = require("../dist/utils/reply.js");
const { parseAgentMessageBody, AGENT_CARD_MAX_CHARS } = require("../dist/utils/agent-message.js");
const { chatPushBodies } = require("../dist/services/chat-push.js");
const { deliverNewMessage } = require("../dist/socket/rooms.js");

const app = express();
app.use(express.json());
app.use("/v1/api", router);

const KEY = "test-chat-internal-key";
const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET_KEY, { expiresIn: "1h" });
const listen = () => new Promise((resolve) => { const server = app.listen(0, () => resolve(server)); });
const request = (port, method, url, { key, as, headers = {}, body } = {}) =>
  new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        port,
        path: url,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(key ? { "X-Internal-Key": key } : {}),
          ...(as ? { Authorization: `Bearer ${tokenFor(as)}` } : {}),
          ...headers,
        },
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

const ORG = oid();
const MEMBER = oid();
const CANDIDATE = oid();
const BUYER = oid();
const SELLER = oid();
const STRANGER = oid();
const ADMIN = oid();
const ORGANIZATION = { _id: ORG, name: "Lao Coffee Co", nameLao: "ບໍລິສັດ ກາເຟລາວ", logo: "https://cdn.test/logo.png", slug: "lao-coffee" };

/** The backend lets MEMBER do anything for ORG, and nobody else anything. */
const allowMember = (body) =>
  body.actorUserId === MEMBER && body.organizationId === ORG
    ? { allow: true, organization: ORGANIZATION }
    : { allow: false, code: "ORG_CHAT_NOT_MEMBER", organization: ORGANIZATION };

const past = (ms) => new Date(Date.now() - ms);

/** An order conversation between BUYER and SELLER, as the backend stores it. */
const orderConversation = (overrides = {}) => ({
  _id: oid(),
  conversationType: "PRIVATE",
  orderId: oid(),
  participants: [
    { user: BUYER, userType: "USER", isMuted: false },
    { user: SELLER, userType: "USER", isMuted: false },
  ],
  latestMessageData: { senderId: SELLER, messageId: oid(), messageType: "TEXT", content: "ok", sendAt: past(60_000), readAllAt: null, isDeleted: false },
  createdAt: past(120_000),
  updatedAt: past(60_000),
  ...overrides,
});

/** A company conversation with CANDIDATE, as an open stores it. */
const orgConversation = (overrides = {}) => ({
  _id: oid(),
  conversationType: "PRIVATE",
  organizationId: ORG,
  candidateUserId: CANDIDATE,
  participants: [{ user: CANDIDATE, userType: "USER", isMuted: false }],
  organization: { name: ORGANIZATION.name, nameLao: ORGANIZATION.nameLao, logo: ORGANIZATION.logo, slug: ORGANIZATION.slug },
  conversationName: ORGANIZATION.nameLao,
  basis: "APPLICATION",
  openedBy: MEMBER,
  latestMessageData: { senderId: MEMBER, messageId: oid(), messageType: "TEXT", content: "hello", sendAt: past(60_000), readAllAt: null, isDeleted: false },
  createdAt: past(120_000),
  updatedAt: past(60_000),
  ...overrides,
});

const agreementCard = (overrides = {}) => ({
  type: "AGREEMENT",
  v: 1,
  id: "card-agreement-1",
  createdAt: "2026-10-02T03:00:00.000Z",
  fallbackText: "ຂໍ້ຕົກລົງ: ອອກແບບໂລໂກ້ 3 ແບບ, 500.000 ກີບ, ສົ່ງພາຍໃນ 7 ວັນ",
  orderId: oid(),
  items: [{ text: "ອອກແບບໂລໂກ້ 3 ແບບ", sourceMessageIds: [oid(), oid()] }],
  price: { amount: 500000, currency: "LAK", source: "order" },
  openQuestions: ["ໄຟລ໌ຕົ້ນສະບັບແມ່ນ AI ຫຼື PSD?"],
  disclaimer: "ນີ້ແມ່ນບົດສະຫຼຸບ — ບໍ່ແມ່ນສັນຍາ",
  ...overrides,
});

const THREAD = oid();
const ACTION = oid();
const agentBody = (conversationId, overrides = {}, agentOverrides = {}) => ({
  conversationId,
  requestedBy: BUYER,
  content: "ສະຫຼຸບຂໍ້ຕົກລົງໂດຍ Seemue AI: ອອກແບບໂລໂກ້ 3 ແບບ, 500.000 ກີບ",
  agent: { v: 1, kind: "AGREEMENT", card: agreementCard(), threadId: THREAD, actionId: ACTION, ...agentOverrides },
  ...overrides,
});

/** Everything a test needs, with the key set; `restore` puts it back. */
const setup = ({ enabled = "true", authorize = allowMember, seed, key = KEY, backend = {} } = {}) => {
  published.length = 0;
  warnings.length = 0;
  cached.clear();
  const store = installStore(seed);
  const fakeBackend = installBackend({ authorize, ...backend });
  // Every conversation read, so "refused before anything is read" can be checked.
  const reads = [];
  const findOne = conversationModel.findOne;
  const restores = [
    stub(conversationModel, "findOne", (filter, ...rest) => {
      reads.push(filter);
      return findOne(filter, ...rest);
    }),
    stub(env, "ORG_CHAT_ENABLED", enabled),
    stub(env, "BACKEND_URL", "https://api.test"),
    stub(env, "CHAT_INTERNAL_KEY", key),
    stub(messageStatusModel, "find", () => query([])),
  ];
  return {
    ...store,
    reads,
    backend: fakeBackend,
    restore: () => {
      restores.reverse().forEach((undo) => undo());
      fakeBackend.restore();
      store.restore();
    },
  };
};

const post = (port, body, key = KEY) => request(port, "POST", "/v1/api/agent-messages", { key, body });
const sent = () => published.filter((p) => p.channel === "SEND_MESSAGE").map((p) => p.message);

let server;
let port;
test.before(async () => {
  server = await listen();
  port = server.address().port;
});
test.after(() => server.close());

// ---------------------------------------------------------------- the key

test("POST /agent-messages: X-Internal-Key, fail closed", async (t) => {
  const conversation = orderConversation();
  const unauthorized = {
    success: false,
    code: "CHAT-401",
    message: "Unauthorized",
    errors: { code: "UNAUTHORIZED", message: "Unauthorized" },
  };

  for (const [label, options] of [
    ["no key", { key: undefined }],
    ["a wrong key", { key: `${KEY}x` }],
    ["a user's access token instead of the key", { key: undefined, as: BUYER }],
  ]) {
    await t.test(`${label}: 401, nothing read, stored or published`, async () => {
      const world = setup({ seed: { conversations: [conversation] } });
      try {
        const res = await request(port, "POST", "/v1/api/agent-messages", { ...options, body: agentBody(conversation._id) });
        assert.strictEqual(res.status, 401);
        assert.deepStrictEqual(res.body, unauthorized);
        assert.deepStrictEqual(world.reads, []);
        assert.strictEqual(world.db.messages.length, 0);
        assert.deepStrictEqual(published, []);
        assert.ok(warnings.some((w) => w.msg === "internal_key_refused" && w.path === "/v1/api/agent-messages"));
      } finally {
        world.restore();
      }
    });
  }

  await t.test("CHAT_INTERNAL_KEY not configured: refused too (unlike /orders and /core-socket), with a warning", async () => {
    const world = setup({ key: null, seed: { conversations: [conversation] } });
    try {
      for (const key of [undefined, KEY, ""]) {
        const res = await post(port, agentBody(conversation._id), key);
        assert.strictEqual(res.status, 401);
        assert.deepStrictEqual(res.body, unauthorized);
      }
      assert.deepStrictEqual(world.reads, []);
      assert.strictEqual(world.db.messages.length, 0);
      assert.deepStrictEqual(published, []);
      assert.deepStrictEqual(warnings[0], { msg: "internal_key_unset", path: "/v1/api/agent-messages", action: "refused" });
    } finally {
      world.restore();
    }
  });
});

// ---------------------------------------------------------------- the body

test("POST /agent-messages: a bad body is 400 VALIDATION_ERROR before anything is read", async (t) => {
  const conversation = orderConversation();
  const id = conversation._id;
  const cases = [
    ["no conversationId", agentBody(undefined), "conversationId"],
    ["a conversationId that is not an id", agentBody("nope"), "conversationId"],
    ["no requestedBy", agentBody(id, { requestedBy: undefined }), "requestedBy"],
    ["a requestedBy that is an object", agentBody(id, { requestedBy: { $ne: null } }), "requestedBy"],
    ["no content", agentBody(id, { content: undefined }), "content"],
    ["blank content", agentBody(id, { content: "   " }), "content"],
    ["content over 2000 characters", agentBody(id, { content: "ກ".repeat(2001) }), "content"],
    ["content that is not text", agentBody(id, { content: 42 }), "content"],
    ["no agent", agentBody(id, { agent: undefined }), "agent"],
    ["an agent that is a list", agentBody(id, { agent: [] }), "agent"],
    ["agent.v 2", agentBody(id, {}, { v: 2 }), "agent.v"],
    ["an unknown kind", agentBody(id, {}, { kind: "VERDICT" }), "agent.kind"],
    ["no card", agentBody(id, {}, { card: undefined }), "agent.card"],
    ["a card that is a string", agentBody(id, {}, { card: "AGREEMENT" }), "agent.card"],
    ["a card without a type", agentBody(id, {}, { card: agreementCard({ type: undefined }) }), "agent.card.type"],
    ["a lower-case card type", agentBody(id, {}, { card: agreementCard({ type: "agreement" }) }), "agent.card.type"],
    ["card.v 0", agentBody(id, {}, { card: agreementCard({ v: 0 }) }), "agent.card.v"],
    ["card.v as text", agentBody(id, {}, { card: agreementCard({ v: "1" }) }), "agent.card.v"],
    ["a card without an id", agentBody(id, {}, { card: agreementCard({ id: "" }) }), "agent.card.id"],
    ["a card without fallbackText", agentBody(id, {}, { card: agreementCard({ fallbackText: undefined }) }), "agent.card.fallbackText"],
    ["a fallbackText over 2000", agentBody(id, {}, { card: agreementCard({ fallbackText: "ກ".repeat(2001) }) }), "agent.card.fallbackText"],
    ["a $-key deep in the card", agentBody(id, {}, { card: agreementCard({ items: [{ text: "x", sourceMessageIds: [], meta: { $where: "1" } }] }) }), "agent.card"],
    ["a card too large", agentBody(id, {}, { card: agreementCard({ disclaimer: "ກ".repeat(AGENT_CARD_MAX_CHARS) }) }), "agent.card"],
    ["a threadId that is not an id", agentBody(id, {}, { threadId: "a b" }), "agent.threadId"],
    ["an actionId that is an object", agentBody(id, {}, { actionId: { $ne: null } }), "agent.actionId"],
    ["an agent.requestedBy that is someone else", agentBody(id, {}, { requestedBy: STRANGER }), "agent.requestedBy"],
  ];
  for (const [label, body, field] of cases) {
    await t.test(`${label}: ${field}`, async () => {
      const world = setup({ seed: { conversations: [conversation] } });
      try {
        const res = await post(port, body);
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.body, { success: false, errors: { code: "VALIDATION_ERROR", message: `${field} is invalid` } });
        assert.deepStrictEqual(world.reads, []);
        assert.strictEqual(world.db.messages.length, 0);
        assert.deepStrictEqual(published, []);
      } finally {
        world.restore();
      }
    });
  }

  await t.test("parseAgentMessageBody: trims, lower-cases the ids, keeps only the agent fields it knows", () => {
    const parsed = parseAgentMessageBody({
      ...agentBody(id.toUpperCase(), { requestedBy: BUYER.toUpperCase(), content: "  ສະບາຍດີ  ", extra: "ignored" }, { requestedBy: BUYER, sneaky: true, threadId: null }),
    });
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.value.conversationId, id);
    assert.strictEqual(parsed.value.requestedBy, BUYER);
    assert.strictEqual(parsed.value.content, "ສະບາຍດີ");
    assert.deepStrictEqual(Object.keys(parsed.value.agent).sort(), ["actionId", "card", "kind", "v"]);
  });
});

// ---------------------------------------------------------------- a participant

test("POST /agent-messages: a participant's request", async (t) => {
  await t.test("201: stored as the requester's AGENT message, the conversation moved by updateOne, SEND_MESSAGE out, no push", async () => {
    const conversation = orderConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const body = agentBody(conversation._id);
      const res = await post(port, body);
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      const { message } = res.body.data;
      assert.deepStrictEqual(Object.keys(res.body.data), ["message"]);

      assert.strictEqual(message.messageType, "AGENT");
      assert.strictEqual(message.sender, BUYER);
      assert.strictEqual(message.actorUserId, BUYER);
      assert.strictEqual(message.conversation, conversation._id);
      assert.strictEqual(message.content, body.content);
      assert.ok(!("sendAsOrganizationId" in message), "a participant posts as themselves");
      assert.deepStrictEqual(message.agent, {
        v: 1,
        kind: "AGREEMENT",
        card: body.agent.card,
        threadId: THREAD,
        actionId: ACTION,
        requestedBy: BUYER,
      });
      assert.strictEqual(world.db.messages.length, 1);
      assert.strictEqual(world.db.messages[0]._id, message._id);

      // latestMessageData: one updateOne, timestamps on (it moves the chat up), never .save() (the store fails one).
      const writes = world.calls.writes.filter((w) => w.collection === "conversations");
      assert.deepStrictEqual(writes.map((w) => w.kind), ["updateOne"]);
      assert.notStrictEqual(writes[0].options.timestamps, false);
      const stored = world.db.conversations[0];
      assert.deepStrictEqual(
        { ...stored.latestMessageData, sendAt: undefined },
        { senderId: BUYER, messageId: message._id, messageType: "AGENT", content: body.content, sendAt: undefined, readAllAt: null, isDeleted: false }
      );
      assert.ok(new Date(stored.updatedAt) > new Date(conversation.updatedAt), "the conversation moved to the top");
      assert.deepStrictEqual(stored.participants, JSON.parse(JSON.stringify(conversation.participants)), "participants untouched");

      // Delivered like any message.
      const [notice] = sent();
      assert.strictEqual(sent().length, 1);
      assert.deepStrictEqual(notice.messageData, message);
      assert.strictEqual(notice.conversation._id, conversation._id);
      assert.deepStrictEqual(notice.conversation.participants.map((p) => p.user), [BUYER, SELLER]);
      assert.strictEqual(notice.conversation.latestMessageData.messageId, message._id);
      assert.strictEqual(notice.conversation.latestMessageData.messageType, "AGENT");

      await settle();
      assert.deepStrictEqual(world.backend.calls, [], "no push, and no authorize for a participant");
      assert.strictEqual(logged("agent_message_posted", { conversationId: conversation._id, requestedBy: BUYER }).length, 1);
    } finally {
      world.restore();
    }
  });

  await t.test("the other side of the order may ask too; a NOTE without thread or action ids", async () => {
    const conversation = orderConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const card = { type: "TRANSLATION", v: 1, id: "card-t-1", fallbackText: "ແປ: hello → ສະບາຍດີ", from: "en", to: "lo", text: "ສະບາຍດີ" };
      const res = await post(port, { conversationId: conversation._id, requestedBy: SELLER, content: "ແປໂດຍ Seemue AI: ສະບາຍດີ", agent: { v: 1, kind: "NOTE", card } });
      assert.strictEqual(res.status, 201);
      assert.deepStrictEqual(res.body.data.message.agent, { v: 1, kind: "NOTE", card, requestedBy: SELLER });
      assert.strictEqual(world.db.conversations[0].latestMessageData.senderId, SELLER);
    } finally {
      world.restore();
    }
  });

  await t.test("someone who is not a participant: 403 NOT_PARTICIPANT, nothing stored or published", async () => {
    const conversation = orderConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const res = await post(port, agentBody(conversation._id, { requestedBy: STRANGER }));
      assert.strictEqual(res.status, 403);
      assert.deepStrictEqual(res.body, { success: false, errors: { code: "NOT_PARTICIPANT", message: "requestedBy is not a participant of this conversation" } });
      assert.strictEqual(world.db.messages.length, 0);
      assert.deepStrictEqual(world.calls.writes, []);
      assert.deepStrictEqual(published, []);
      assert.deepStrictEqual(world.backend.calls, [], "not a company conversation: nobody to ask");
    } finally {
      world.restore();
    }
  });

  await t.test("a conversation that does not exist: 404 CONVERSATION_NOT_FOUND", async () => {
    const world = setup({ seed: { conversations: [orderConversation()] } });
    try {
      const res = await post(port, agentBody(oid()));
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(res.body, { success: false, errors: { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" } });
      assert.strictEqual(world.db.messages.length, 0);
      assert.deepStrictEqual(published, []);
    } finally {
      world.restore();
    }
  });
});

// ---------------------------------------------------------------- company conversations

test("POST /agent-messages: company conversations", async (t) => {
  await t.test("a member the backend lets SEND: 201, as the company, delivered to the candidate and the org room", async () => {
    const conversation = orgConversation({ organization: { name: "Old name" }, conversationName: "Old name" });
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const res = await post(port, agentBody(conversation._id, { requestedBy: MEMBER }, { kind: "NOTE" }));
      assert.strictEqual(res.status, 201);
      const { message } = res.body.data;
      assert.strictEqual(message.sender, MEMBER);
      assert.strictEqual(message.actorUserId, MEMBER);
      assert.strictEqual(message.sendAsOrganizationId, ORG);
      assert.strictEqual(message.agent.requestedBy, MEMBER);
      assert.deepStrictEqual(world.backend.authorizations(), [{ action: "SEND", organizationId: ORG, actorUserId: MEMBER }]);

      const stored = world.db.conversations[0];
      assert.strictEqual(stored.latestMessageData.messageId, message._id);
      assert.strictEqual(stored.latestMessageData.messageType, "AGENT");
      // Refreshed from the backend's answer, as on any company message.
      assert.strictEqual(stored.organization.nameLao, ORGANIZATION.nameLao);
      assert.strictEqual(stored.conversationName, ORGANIZATION.nameLao);
      // Members are never participants.
      assert.deepStrictEqual(stored.participants.map((p) => p.user), [CANDIDATE]);

      const [notice] = sent();
      assert.strictEqual(notice.conversation.organizationId, ORG);
      const rooms = [];
      deliverNewMessage({ to: (room) => ({ emit: (event, payload) => rooms.push({ room, event, type: payload.type }) }) }, notice.conversation, notice.messageData, (fn) => fn());
      assert.deepStrictEqual(rooms.filter((r) => r.type === "NEW_MESSAGE").map((r) => r.room), [CANDIDATE, `org:${ORG}`]);

      await settle();
      assert.deepStrictEqual(world.backend.pushes(), [], "no push to the candidate");
    } finally {
      world.restore();
    }
  });

  await t.test("the candidate (the participant): 201 as themselves, without asking the backend", async () => {
    const conversation = orgConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const res = await post(port, agentBody(conversation._id, { requestedBy: CANDIDATE }));
      assert.strictEqual(res.status, 201);
      assert.ok(!("sendAsOrganizationId" in res.body.data.message));
      assert.deepStrictEqual(world.backend.authorizations(), []);
      assert.strictEqual(sent().length, 1);
    } finally {
      world.restore();
    }
  });

  await t.test("someone the backend refuses: its ORG_CHAT_* code, nothing stored", async () => {
    const conversation = orgConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const res = await post(port, agentBody(conversation._id, { requestedBy: STRANGER }));
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.errors.code, "ORG_CHAT_NOT_MEMBER");
      assert.strictEqual(world.db.messages.length, 0);
      assert.deepStrictEqual(published, []);
    } finally {
      world.restore();
    }
  });

  await t.test("a member without the SEND permission: 403 ORG_CHAT_FORBIDDEN", async () => {
    const conversation = orgConversation();
    const world = setup({ seed: { conversations: [conversation] }, authorize: () => ({ allow: false, code: "ORG_CHAT_FORBIDDEN", organization: ORGANIZATION }) });
    try {
      const res = await post(port, agentBody(conversation._id, { requestedBy: MEMBER }));
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.errors.code, "ORG_CHAT_FORBIDDEN");
      assert.strictEqual(world.db.messages.length, 0);
    } finally {
      world.restore();
    }
  });

  await t.test("the backend unreachable: 503 ORG_CHAT_UNAVAILABLE, nothing stored", async () => {
    const conversation = orgConversation();
    const world = setup({
      seed: { conversations: [conversation] },
      authorize: () => {
        throw new Error("down");
      },
    });
    try {
      const res = await post(port, agentBody(conversation._id, { requestedBy: MEMBER }));
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.errors.code, "ORG_CHAT_UNAVAILABLE");
      assert.strictEqual(world.db.messages.length, 0);
    } finally {
      world.restore();
    }
  });

  await t.test("ORG_CHAT_ENABLED off: a member gets 403 ORG_CHAT_DISABLED; the candidate still posts", async () => {
    const conversation = orgConversation();
    const world = setup({ enabled: "false", seed: { conversations: [conversation] } });
    try {
      const member = await post(port, agentBody(conversation._id, { requestedBy: MEMBER }));
      assert.strictEqual(member.status, 403);
      assert.strictEqual(member.body.errors.code, "ORG_CHAT_DISABLED");
      assert.deepStrictEqual(world.backend.calls, []);
      const candidate = await post(port, agentBody(conversation._id, { requestedBy: CANDIDATE }));
      assert.strictEqual(candidate.status, 201);
    } finally {
      world.restore();
    }
  });

  for (const [who, requestedBy, text] of [
    ["the candidate", CANDIDATE, "ທ່ານໄດ້ບລັອກບໍລິສັດນີ້ແລ້ວ"],
    ["a member", MEMBER, "ຜູ້ສະໝັກໄດ້ບລັອກບໍລິສັດຂອງທ່ານ"],
  ]) {
    await t.test(`a blocked company conversation refuses ${who}: 403 ORG_CHAT_BLOCKED, nothing stored or published`, async () => {
      const conversation = orgConversation({ candidateBlockedAt: past(10_000) });
      const world = setup({ seed: { conversations: [conversation] } });
      try {
        const res = await post(port, agentBody(conversation._id, { requestedBy }));
        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(res.body, { success: false, errors: { code: "ORG_CHAT_BLOCKED", message: text } });
        assert.strictEqual(world.db.messages.length, 0);
        assert.deepStrictEqual(world.calls.writes, []);
        assert.deepStrictEqual(published, []);
      } finally {
        world.restore();
      }
    });
  }

  await t.test("a block that lands between the check and the write: refused, and the message is removed again", async () => {
    const conversation = orgConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    const create = messageModel.create;
    const undo = stub(messageModel, "create", async (doc) => {
      const made = await create(doc);
      world.db.conversations[0].candidateBlockedAt = new Date();
      return made;
    });
    try {
      const res = await post(port, agentBody(conversation._id, { requestedBy: CANDIDATE }));
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.errors.code, "ORG_CHAT_BLOCKED");
      assert.strictEqual(world.db.messages.length, 0);
      assert.deepStrictEqual(published, []);
    } finally {
      undo();
      world.restore();
    }
  });
});

// ---------------------------------------------------------------- clients cannot forge one

const forgedAgent = () => ({ v: 1, kind: "AGREEMENT", card: agreementCard(), requestedBy: STRANGER });

test("AGENT is server-only", async (t) => {
  await t.test("not a client type; a server type, like SYSTEM and ORDER_*", () => {
    assert.strictEqual(MessageType.AGENT, "AGENT");
    assert.strictEqual(CLIENT_MESSAGE_TYPES.has("AGENT"), false);
    assert.strictEqual(isClientMessageType("AGENT"), false);
    for (const type of ["AGENT", "SYSTEM", "ORDER_PAYMENT"]) assert.strictEqual(isServerMessageType(type), true, type);
    for (const type of ["TEXT", "STICKER", "IMAGE", undefined]) assert.strictEqual(isServerMessageType(type), false, String(type));
  });

  await t.test("POST /messages with messageType AGENT: 400 INVALID_MESSAGE_TYPE before anything is read", async () => {
    const conversation = orderConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const res = await request(port, "POST", "/v1/api/messages", { as: BUYER, body: { conversationId: conversation._id, body: "hi", messageType: "AGENT", agent: forgedAgent() } });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "CHAT-400");
      assert.strictEqual(res.body.errors.code, "INVALID_MESSAGE_TYPE");
      assert.deepStrictEqual(world.reads, []);
      assert.strictEqual(world.db.messages.length, 0);
    } finally {
      world.restore();
    }
  });

  await t.test("POST /organizations/conversations/:id/messages with messageType AGENT: 400 INVALID_MESSAGE_TYPE", async () => {
    const conversation = orgConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const res = await request(port, "POST", `/v1/api/organizations/conversations/${conversation._id}/messages`, { as: MEMBER, body: { body: "hi", messageType: "AGENT" } });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.errors.code, "INVALID_MESSAGE_TYPE");
      assert.strictEqual(world.db.messages.length, 0);
    } finally {
      world.restore();
    }
  });

  await t.test("POST /messages with an `agent` field: stored as a plain TEXT, without it", async () => {
    const conversation = orderConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const res = await request(port, "POST", "/v1/api/messages", { as: BUYER, body: { conversationId: conversation._id, body: "hi", agent: forgedAgent() } });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.messageType, "TEXT");
      assert.ok(!("agent" in res.body.data));
      assert.ok(!("agent" in world.db.messages[0]));
    } finally {
      world.restore();
    }
  });

  await t.test("a company message with an `agent` field: stored without it", async () => {
    const conversation = orgConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const res = await request(port, "POST", `/v1/api/organizations/conversations/${conversation._id}/messages`, { as: MEMBER, body: { body: "hi", agent: forgedAgent() } });
      assert.strictEqual(res.status, 201);
      assert.ok(!("agent" in world.db.messages[0]));
    } finally {
      world.restore();
    }
  });

  await t.test("a chat push never goes out for one", () => {
    const conversation = orderConversation();
    const message = { _id: oid(), sender: BUYER, conversation: conversation._id, messageType: "AGENT", content: "x", agent: forgedAgent() };
    assert.deepStrictEqual(chatPushBodies(conversation, message), []);
  });
});

test("the socket: AGENT refused, `agent` stripped", async (t) => {
  const conversationId = oid();
  const server = await harness.startServer();
  server.setMembers(conversationId, [BUYER, SELLER]);
  const client = await server.userClient(BUYER);

  await t.test("NEW_MESSAGE with messageType AGENT: ERROR INVALID_PAYLOAD field messageType, nothing sent", async () => {
    const error = nextEvent(client, "ERROR");
    client.emit("NEW_MESSAGE", { _id: oid(), conversationId, messageType: "AGENT", content: "agreed", agent: forgedAgent() });
    const refused = await error;
    assert.deepStrictEqual({ code: refused.code, field: refused.field, event: refused.event }, { code: "INVALID_PAYLOAD", field: "messageType", event: "NEW_MESSAGE" });
    await settle(40);
    assert.deepStrictEqual(server.calls.private, []);
  });

  await t.test("NEW_MESSAGE TEXT with an `agent` field: sent without it", async () => {
    client.emit("NEW_MESSAGE", { _id: oid(), conversationId, messageType: "TEXT", content: "hi", agent: forgedAgent() });
    await until(() => server.calls.private.length === 1);
    assert.ok(!("agent" in server.calls.private[0]));
    assert.strictEqual(server.calls.private[0].content, "hi");
  });

  await t.test("NEW_GROUP_MESSAGE TEXT with an `agent` field: sent without it", async () => {
    client.emit("NEW_GROUP_MESSAGE", { _id: oid(), conversationId, messageType: "TEXT", content: "hi", agent: forgedAgent() });
    await until(() => server.calls.group.length === 1);
    assert.ok(!("agent" in server.calls.group[0]));
  });

  await server.close();
});

// ---------------------------------------------------------------- no replies, no reactions

test("an AGENT message cannot be replied to", async (t) => {
  await t.test("replyDropReason: SERVER_MESSAGE, as SYSTEM and ORDER_*", () => {
    const conversationId = new Types.ObjectId();
    const target = { _id: new Types.ObjectId(), conversation: conversationId, sender: new Types.ObjectId(), isDeleted: false, isOrderMessage: false };
    for (const messageType of ["AGENT", "SYSTEM", "ORDER_PAYMENT"]) {
      assert.strictEqual(replyDropReason(String(target._id), { ...target, messageType }, conversationId), "SERVER_MESSAGE", messageType);
    }
    assert.strictEqual(replyDropReason(String(target._id), { ...target, messageType: "TEXT" }, conversationId), null);
  });

  await t.test("a company reply to one: delivered as a normal message, reply_dropped SERVER_MESSAGE", async () => {
    const conversation = orgConversation();
    const agentMessage = { _id: oid(), conversation: conversation._id, sender: CANDIDATE, actorUserId: CANDIDATE, messageType: "AGENT", content: "card", agent: forgedAgent(), sendAt: past(1000), createdAt: past(1000), isDeleted: false, isOrderMessage: false };
    const world = setup({ seed: { conversations: [conversation], messages: [agentMessage] } });
    try {
      const res = await request(port, "POST", `/v1/api/organizations/conversations/${conversation._id}/messages`, { as: MEMBER, body: { body: "thanks", replyTo: agentMessage._id } });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.isReply, false);
      assert.ok(!("replyPreview" in res.body.data));
      assert.strictEqual(logged("reply_dropped", { replyTo: agentMessage._id, reason: "SERVER_MESSAGE" }).length, 1);
    } finally {
      world.restore();
    }
  });
});

test("an AGENT message cannot be reacted to", async (t) => {
  await t.test("reactionTargetProblem: SERVER_MESSAGE", () => {
    assert.strictEqual(reactionTargetProblem({ messageType: "AGENT" }), "SERVER_MESSAGE");
  });

  await t.test("REACT_MESSAGE on one, from a participant: ERROR INVALID_PAYLOAD field messageId, nothing written or published", async () => {
    const conversationId = oid();
    const message = { _id: new Types.ObjectId(), conversation: new Types.ObjectId(conversationId), sender: new Types.ObjectId(SELLER), messageType: "AGENT", isDeleted: false, isOrderMessage: false };
    const writes = [];
    const server = await harness.startServer({
      deps: {
        findReactionTarget: async (id) => (id === String(message._id) ? { ...message } : null),
        writeReaction: async (messageId, userId, emoji, at) => {
          writes.push({ messageId, userId, emoji });
          return { reactions: applyReaction([], userId, emoji, at) };
        },
      },
    });
    server.setMembers(conversationId, [BUYER, SELLER]);
    const client = await server.userClient(BUYER);
    const heard = collect(client, "CONVERSATION_LISTENING");
    const error = nextEvent(client, "ERROR");
    client.emit("REACT_MESSAGE", { messageId: String(message._id), emoji: "👍" });
    const refused = await error;
    assert.deepStrictEqual({ code: refused.code, field: refused.field, messageId: refused.messageId }, { code: "INVALID_PAYLOAD", field: "messageId", messageId: String(message._id) });
    await settle(40);
    assert.deepStrictEqual(writes, []);
    assert.deepStrictEqual(server.published("REACTION"), []);
    assert.deepStrictEqual(heard, []);
    assert.strictEqual(logged("reaction_refused", { messageId: String(message._id), reason: "SERVER_MESSAGE" }).length, 1);
    await server.close();
  });
});

// ---------------------------------------------------------------- read paths

test("the lists show an AGENT message as stored, `agent` included", async (t) => {
  const posted = async (world, conversation, requestedBy) => {
    const res = await post(port, agentBody(conversation._id, { requestedBy }));
    assert.strictEqual(res.status, 201);
    return res.body.data.message;
  };

  await t.test("GET /messages (a participant)", async () => {
    const conversation = orderConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const message = await posted(world, conversation, BUYER);
      const res = await request(port, "GET", `/v1/api/messages?conversationId=${conversation._id}`, { as: SELLER });
      assert.strictEqual(res.status, 200);
      const [listed] = res.body.data;
      assert.strictEqual(listed._id, message._id);
      assert.strictEqual(listed.messageType, "AGENT");
      assert.strictEqual(listed.content, message.content);
      assert.deepStrictEqual(listed.agent, message.agent);
    } finally {
      world.restore();
    }
  });

  await t.test("GET /conversations: latestMessageData is the AGENT message, with its content", async () => {
    const conversation = orderConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const message = await posted(world, conversation, BUYER);
      const res = await request(port, "GET", "/v1/api/conversations", { as: SELLER });
      assert.strictEqual(res.status, 200);
      const [row] = res.body.data;
      assert.strictEqual(row.latestMessageData.messageId, message._id);
      assert.strictEqual(row.latestMessageData.messageType, "AGENT");
      assert.strictEqual(row.latestMessageData.content, message.content);
      assert.strictEqual(row.latestMessageData.senderId, BUYER);
      assert.strictEqual(row.latestMessageData.isRead, false, "unread for the other side, like any new message");
    } finally {
      world.restore();
    }
  });

  await t.test("GET /organizations/conversations/:id/messages (the company)", async () => {
    const conversation = orgConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const message = await posted(world, conversation, CANDIDATE);
      const res = await request(port, "GET", `/v1/api/organizations/conversations/${conversation._id}/messages`, { as: MEMBER });
      assert.strictEqual(res.status, 200);
      const [listed] = res.body.data.messages;
      assert.strictEqual(listed._id, message._id);
      assert.deepStrictEqual(listed.agent, message.agent);
    } finally {
      world.restore();
    }
  });

  await t.test("GET /messages/admin", async () => {
    const conversation = orderConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    const admin = stub(userModel, "findById", (id) => query(String(id) === ADMIN ? { role: "ADMIN" } : { role: "USER" }));
    try {
      const message = await posted(world, conversation, BUYER);
      const res = await request(port, "GET", `/v1/api/messages/admin?conversationId=${conversation._id}`, { as: ADMIN });
      assert.strictEqual(res.status, 200);
      const listed = res.body.data.messages.find((m) => m._id === message._id);
      assert.strictEqual(listed.messageType, "AGENT");
      assert.deepStrictEqual(listed.agent, message.agent);
    } finally {
      admin();
      world.restore();
    }
  });
});

test("the Message schema keeps `agent`, and stores none on other messages", async (t) => {
  await t.test("an AGENT message keeps its card as sent", () => {
    const card = agreementCard();
    const doc = new messageModel({ sender: new Types.ObjectId(BUYER), messageType: "AGENT", content: "x", agent: { v: 1, kind: "CHECKLIST", card, requestedBy: new Types.ObjectId(BUYER) } });
    assert.strictEqual(doc.validateSync(), undefined);
    const object = JSON.parse(JSON.stringify(doc.toObject()));
    assert.deepStrictEqual(object.agent, { v: 1, kind: "CHECKLIST", card, requestedBy: BUYER });
  });

  await t.test("a TEXT message has no agent field at all", () => {
    const doc = new messageModel({ sender: new Types.ObjectId(BUYER), messageType: "TEXT", content: "x" });
    assert.ok(!("agent" in doc.toObject()));
  });

  await t.test("an unknown kind fails validation", () => {
    const doc = new messageModel({ messageType: "AGENT", content: "x", agent: { v: 1, kind: "VERDICT", card: agreementCard() } });
    assert.ok(doc.validateSync()?.errors?.["agent.kind"]);
  });
});
