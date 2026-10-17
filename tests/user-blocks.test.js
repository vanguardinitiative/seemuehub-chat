/**
 * User blocks in chat (worktrees/STORE-SAFETY-CONTRACT.md §2.2), against the
 * compiled dist/ with no Redis, no Mongo and no backend
 * (tests/helpers/offline.js, tests/helpers/org-chat-fakes.js,
 * tests/helpers/socket-harness.js): npm test
 *
 * - The pure rules: which conversation is a private one-to-one, who the other
 *   person is, whether a pair is blocked (either direction), the queries.
 * - The read-only mirror of the backend's `userblocks`: no indexes, never
 *   created by this service.
 * - REST POST /messages and socket NEW_MESSAGE into a blocked pair's private
 *   conversation: 403 / ERROR CHAT_USER_BLOCKED, nothing stored, published or
 *   pushed; the same answer whoever blocked whom. Order and company
 *   conversations are untouched.
 * - POST /conversations/private: 403 CHAT_USER_BLOCKED either way; with an
 *   orderId it is not checked.
 * - GET /conversations hides what the caller blocked, not what blocked them.
 * - The read PUT keeps the reader's own marks and tells nobody else;
 *   REACT_MESSAGE, TYPING and DELIVERED are dropped silently.
 * - One indexed userblocks query per check.
 */
const { published, cached, stub, query } = require("./helpers/offline");
const { installBackend, installStore, oid } = require("./helpers/org-chat-fakes");
const harness = require("./helpers/socket-harness");
const { collect, logged, settle, until } = harness;

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { Types } = mongoose;

const router = require("../dist/routes/index.js").default;
const { env } = require("../dist/config/env.js");
const { conversationModel } = require("../dist/models/conversation.js");
const { messageStatusModel } = require("../dist/models/messageStatus.js");
const { userBlockModel } = require("../dist/models/user-block.js");
const { sendPrivateMessage } = require("../dist/controllers/message/index.js");
const blocks = require("../dist/utils/user-blocks.js");
const service = require("../dist/services/user-blocks.js");
const { TYPING_RULES } = require("../dist/socket/typing.js");

const app = express();
app.use(express.json());
app.use("/v1/api", router);

const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET_KEY, { expiresIn: "1h" });
const listen = () => new Promise((resolve) => { const server = app.listen(0, () => resolve(server)); });
const request = (port, method, url, { as, key, body } = {}) =>
  new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        port,
        path: url,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(as ? { Authorization: `Bearer ${tokenFor(as)}` } : {}),
          ...(key ? { "X-Internal-Key": key } : {}),
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

const ALICE = oid();
const BOB = oid();
const CAROL = oid();
const ORG = oid();
const KEY = "test-chat-internal-key";
const past = (ms) => new Date(Date.now() - ms);

/** A private one-to-one conversation between `a` and `b`, as the chat creates it; the latest message is `from`'s. */
const privateConversation = (a, b, { from = b, ago = 60_000, ...overrides } = {}) => ({
  _id: oid(),
  conversationName: "Private",
  conversationType: "PRIVATE",
  participants: [
    { user: a, userType: "USER", isMuted: false },
    { user: b, userType: "USER", isMuted: false },
  ],
  latestMessageData: { senderId: from, messageId: oid(), messageType: "TEXT", content: "hi", sendAt: past(ago), readAllAt: null, isDeleted: false },
  createdAt: past(ago + 60_000),
  updatedAt: past(ago),
  ...overrides,
});

/** An order conversation between `a` and `b`, as seemuehub-backend creates it. */
const orderConversation = (a, b, overrides = {}) =>
  privateConversation(a, b, { conversationType: "ORDER", orderId: oid(), orderStatus: "IN_PROGRESS", conversationName: "Order", ...overrides });

/** A company conversation with `candidate`: PRIVATE, an organizationId, one participant. */
const companyConversation = (candidate, overrides = {}) => ({
  ...privateConversation(candidate, candidate, { from: oid() }),
  organizationId: ORG,
  candidateUserId: candidate,
  participants: [{ user: candidate, userType: "USER", isMuted: false }],
  ...overrides,
});

const block = (blockerId, blockedId) => ({ _id: oid(), blockerId, blockedId, createdAt: past(1_000) });

/**
 * The fake collections (seeded), the backend for pushes, and a count of the
 * userblocks queries; `restore` puts everything back.
 */
const setup = (seed = {}) => {
  published.length = 0;
  cached.clear();
  const store = installStore(seed);
  const backend = installBackend({ authorize: () => ({ allow: true, organization: null }) });
  const blockQueries = [];
  const findOne = userBlockModel.findOne;
  const find = userBlockModel.find;
  const restores = [
    stub(userBlockModel, "findOne", (filter) => (blockQueries.push({ kind: "findOne", filter }), findOne(filter))),
    stub(userBlockModel, "find", (filter) => (blockQueries.push({ kind: "find", filter }), find(filter))),
    stub(messageStatusModel, "find", () => query([])),
    stub(env, "BACKEND_URL", "https://api.test"),
    stub(env, "CHAT_INTERNAL_KEY", KEY),
    stub(env, "ORG_CHAT_ENABLED", "true"),
  ];
  return {
    ...store,
    backend,
    blockQueries,
    restore: () => {
      restores.reverse().forEach((undo) => undo());
      backend.restore();
      store.restore();
    },
  };
};

const channel = (name) => published.filter((p) => p.channel === name).map((p) => p.message);

let server;
let port;
test.before(async () => {
  server = await listen();
  port = server.address().port;
});
test.after(() => server.close());

// ---------------------------------------------------------------- the pure rules

test("privatePeerOf: only a private one-to-one conversation the caller is in has a peer", () => {
  const peer = blocks.privatePeerOf;
  assert.strictEqual(peer(privateConversation(ALICE, BOB), ALICE), BOB);
  assert.strictEqual(peer(privateConversation(ALICE, BOB), BOB), ALICE);
  assert.strictEqual(peer(privateConversation(ALICE, BOB), ALICE.toUpperCase()), BOB, "ids compare case-insensitively");
  // No type at all is the schema's default, PRIVATE.
  assert.strictEqual(peer({ ...privateConversation(ALICE, BOB), conversationType: undefined }, ALICE), BOB);
  // ObjectIds and populated users (GET /conversations populates participants.user).
  assert.strictEqual(peer({ participants: [{ user: new Types.ObjectId(ALICE) }, { user: { _id: new Types.ObjectId(BOB), userName: "bob" } }] }, ALICE), BOB);
  // The same person listed twice is still a pair.
  assert.strictEqual(peer({ participants: [{ user: ALICE }, { user: BOB }, { user: BOB }] }, ALICE), BOB);

  for (const [label, conversation] of [
    ["an ORDER conversation", orderConversation(ALICE, BOB)],
    ["an older order conversation typed PRIVATE, with an orderId", { ...privateConversation(ALICE, BOB), orderId: oid() }],
    ["a company conversation", companyConversation(ALICE)],
    ["a PRIVATE conversation with an organizationId and two people", { ...privateConversation(ALICE, BOB), organizationId: ORG }],
    ["a GROUP", { ...privateConversation(ALICE, BOB), conversationType: "GROUP" }],
    ["an ANONYMOUS conversation", { ...privateConversation(ALICE, BOB), conversationType: "ANONYMOUS" }],
    ["three people", { ...privateConversation(ALICE, BOB), participants: [{ user: ALICE }, { user: BOB }, { user: CAROL }] }],
    ["one the caller is not in", privateConversation(BOB, CAROL)],
    ["a deleted user (populated as null)", { ...privateConversation(ALICE, BOB), participants: [{ user: ALICE }, { user: null }] }],
    ["nothing", null],
  ]) {
    assert.strictEqual(peer(conversation, ALICE), null, label);
  }
});

test("isBlockedPair: a row in either direction; hasBlocked: this direction only", () => {
  const rows = [block(ALICE, BOB)];
  assert.strictEqual(blocks.isBlockedPair(rows, ALICE, BOB), true);
  assert.strictEqual(blocks.isBlockedPair(rows, BOB, ALICE), true, "the blocked side is blocked too");
  assert.strictEqual(blocks.isBlockedPair(rows, ALICE, CAROL), false);
  assert.strictEqual(blocks.isBlockedPair(rows, BOB, CAROL), false);
  assert.strictEqual(blocks.isBlockedPair([block(CAROL, BOB)], ALICE, BOB), false, "someone else's block");
  assert.strictEqual(blocks.isBlockedPair(rows, ALICE, ALICE), false);
  assert.strictEqual(blocks.isBlockedPair([], ALICE, BOB), false);
  assert.strictEqual(blocks.isBlockedPair(null, ALICE, BOB), false);
  // Rows as Mongo hands them back: ObjectIds.
  assert.strictEqual(blocks.isBlockedPair([{ blockerId: new Types.ObjectId(BOB), blockedId: new Types.ObjectId(ALICE) }], ALICE.toUpperCase(), BOB), true);

  assert.strictEqual(blocks.hasBlocked(rows, ALICE, BOB), true);
  assert.strictEqual(blocks.hasBlocked(rows, BOB, ALICE), false);
});

test("hiddenByBlock / blockedConversation: the list's two rules", () => {
  const conversation = privateConversation(ALICE, BOB);
  const rows = [block(ALICE, BOB)];
  assert.strictEqual(blocks.hiddenByBlock(conversation, ALICE, rows), true, "the blocker no longer sees it");
  assert.strictEqual(blocks.hiddenByBlock(conversation, BOB, rows), false, "the blocked person still does");
  assert.strictEqual(blocks.blockedConversation(conversation, ALICE, rows), true);
  assert.strictEqual(blocks.blockedConversation(conversation, BOB, rows), true);
  assert.strictEqual(blocks.hiddenByBlock(orderConversation(ALICE, BOB), ALICE, rows), false, "an order's conversation never hides");
  assert.strictEqual(blocks.blockedConversation(orderConversation(ALICE, BOB), ALICE, rows), false);
});

test("the queries: one findOne for a pair (both directions), one find for the list", () => {
  const pair = blocks.blockedPairFilter(ALICE, BOB);
  assert.deepStrictEqual(
    pair.$or.map((branch) => [String(branch.blockerId), String(branch.blockedId)]),
    [[ALICE, BOB], [BOB, ALICE]]
  );
  assert.ok(pair.$or.every((branch) => branch.blockerId instanceof Types.ObjectId && branch.blockedId instanceof Types.ObjectId));
  assert.strictEqual(blocks.blockedPairFilter(ALICE, "nope"), null);
  assert.strictEqual(blocks.blockedPairFilter(undefined, BOB), null);

  const around = blocks.blocksAroundFilter(ALICE, [BOB, CAROL, BOB, "nope"]);
  assert.strictEqual(String(around.$or[0].blockerId), ALICE);
  assert.deepStrictEqual(around.$or[0].blockedId.$in.map(String), [BOB, CAROL]);
  assert.strictEqual(String(around.$or[1].blockedId), ALICE);
  assert.deepStrictEqual(around.$or[1].blockerId.$in.map(String), [BOB, CAROL]);
  assert.strictEqual(blocks.blocksAroundFilter(ALICE, []), null);
  assert.strictEqual(blocks.blocksAroundFilter(ALICE, ["nope"]), null);
});

test("the userblocks model mirrors the backend's collection read only", () => {
  assert.strictEqual(userBlockModel.collection.collectionName, "userblocks");
  assert.strictEqual(userBlockModel.schema.get("autoIndex"), false);
  assert.strictEqual(userBlockModel.schema.get("autoCreate"), false);
  assert.deepStrictEqual(userBlockModel.schema.indexes(), [], "the backend's index sync builds them, never this service");
  for (const path of ["blockerId", "blockedId", "createdAt"]) assert.ok(userBlockModel.schema.path(path), path);
});

test("the services: one indexed userblocks query each, none for other conversations", async (t) => {
  await t.test("isPairBlocked / isPrivateConversationBlocked", async () => {
    const world = setup({ userblocks: [block(ALICE, BOB)] });
    try {
      assert.strictEqual(await service.isPairBlocked(ALICE, BOB), true);
      assert.strictEqual(await service.isPairBlocked(BOB, ALICE), true);
      assert.strictEqual(await service.isPairBlocked(ALICE, CAROL), false);
      assert.strictEqual(world.blockQueries.length, 3);
      assert.ok(world.blockQueries.every((q) => q.kind === "findOne"));

      world.blockQueries.length = 0;
      assert.strictEqual(await service.isPrivateConversationBlocked(privateConversation(ALICE, BOB), BOB), true);
      assert.strictEqual(await service.isPrivateConversationBlocked(orderConversation(ALICE, BOB), BOB), false);
      assert.strictEqual(await service.isPrivateConversationBlocked(companyConversation(ALICE), ALICE), false);
      assert.strictEqual(world.blockQueries.length, 1, "only the private conversation was asked about");
    } finally {
      world.restore();
    }
  });

  await t.test("blockedInConversation reads the conversation by id, then the one findOne", async () => {
    const mine = privateConversation(ALICE, BOB);
    const order = orderConversation(ALICE, BOB);
    const world = setup({ conversations: [mine, order], userblocks: [block(BOB, ALICE)] });
    try {
      assert.strictEqual(await service.blockedInConversation(mine._id, ALICE), true);
      assert.strictEqual(await service.blockedInConversation(order._id, ALICE), false);
      assert.strictEqual(await service.blockedInConversation(oid(), ALICE), false);
      assert.strictEqual(world.blockQueries.length, 1);
    } finally {
      world.restore();
    }
  });

  await t.test("blocksAround: one find, nothing without peers", async () => {
    const world = setup({ userblocks: [block(ALICE, BOB), block(CAROL, ALICE), block(BOB, CAROL)] });
    try {
      const rows = await service.blocksAround(ALICE, [BOB, CAROL]);
      assert.deepStrictEqual(rows.map((row) => [row.blockerId, row.blockedId]).sort(), [[ALICE, BOB], [CAROL, ALICE]].sort());
      assert.deepStrictEqual(await service.blocksAround(ALICE, []), []);
      assert.strictEqual(world.blockQueries.length, 1);
      assert.strictEqual(world.blockQueries[0].kind, "find");
    } finally {
      world.restore();
    }
  });
});

// ---------------------------------------------------------------- REST POST /messages

test("REST POST /messages into a blocked pair's private conversation", async (t) => {
  const send = (conversationId, as, content = "hello?") => request(port, "POST", "/v1/api/messages", { as, body: { conversationId, content } });

  await t.test("403 CHAT_USER_BLOCKED for both sides, the same answer; nothing stored or published", async () => {
    const conversation = privateConversation(ALICE, BOB);
    const world = setup({ conversations: [conversation], userblocks: [block(ALICE, BOB)] });
    try {
      const fromBlocker = await send(conversation._id, ALICE);
      const fromBlocked = await send(conversation._id, BOB);
      for (const res of [fromBlocker, fromBlocked]) {
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.success, false);
        assert.strictEqual(res.body.errors.code, "CHAT_USER_BLOCKED");
        assert.strictEqual(res.body.errors.message, blocks.CHAT_USER_BLOCKED_MESSAGE);
      }
      assert.deepStrictEqual(fromBlocker.body, fromBlocked.body, "nothing tells who blocked whom");
      assert.deepStrictEqual(world.db.messages, []);
      assert.strictEqual(world.db.conversations[0].latestMessageData.content, "hi");
      assert.deepStrictEqual(channel("SEND_MESSAGE"), []);
      assert.deepStrictEqual(world.backend.pushes(), []);
      assert.strictEqual(world.blockQueries.length, 2, "one findOne per send");
      assert.ok(world.blockQueries.every((q) => q.kind === "findOne"));
    } finally {
      world.restore();
    }
  });

  await t.test("an unblocked pair, or after the unblock: 201, at once (no cache)", async () => {
    const conversation = privateConversation(ALICE, BOB);
    const world = setup({ conversations: [conversation], userblocks: [block(ALICE, BOB)] });
    try {
      assert.strictEqual((await send(conversation._id, BOB)).status, 403);
      world.db.userblocks.length = 0;
      const res = await send(conversation._id, BOB, "thanks");
      assert.strictEqual(res.status, 201);
      assert.strictEqual(world.db.messages.length, 1);
      assert.strictEqual(world.db.conversations[0].latestMessageData.content, "thanks");
    } finally {
      world.restore();
    }
  });

  await t.test("a block with someone else changes nothing here", async () => {
    const conversation = privateConversation(ALICE, BOB);
    const world = setup({ conversations: [conversation], userblocks: [block(ALICE, CAROL), block(CAROL, BOB)] });
    try {
      assert.strictEqual((await send(conversation._id, ALICE)).status, 201);
    } finally {
      world.restore();
    }
  });

  await t.test("an order's conversation between the same pair is not affected, and costs no lookup", async () => {
    for (const conversation of [orderConversation(ALICE, BOB), { ...privateConversation(ALICE, BOB), orderId: oid() }]) {
      const world = setup({ conversations: [conversation], userblocks: [block(ALICE, BOB)] });
      try {
        const res = await send(conversation._id, BOB, "the files are attached");
        assert.strictEqual(res.status, 201);
        assert.strictEqual(world.db.messages.length, 1);
        assert.strictEqual(world.blockQueries.length, 0);
      } finally {
        world.restore();
      }
    }
  });

  await t.test("a company conversation keeps its own block only", async () => {
    const conversation = companyConversation(BOB);
    const world = setup({ conversations: [conversation], userblocks: [block(BOB, ALICE)] });
    try {
      assert.strictEqual((await send(conversation._id, BOB, "ສະບາຍດີ")).status, 201);
      assert.strictEqual(world.blockQueries.length, 0);
    } finally {
      world.restore();
    }
  });
});

// ---------------------------------------------------------------- socket NEW_MESSAGE

/** A Mongo session that counts commits and aborts. */
const fakeSession = () => {
  const counts = { committed: 0, aborted: 0 };
  const session = {
    startTransaction() {},
    inTransaction: () => true,
    async commitTransaction() {
      counts.committed++;
    },
    async abortTransaction() {
      counts.aborted++;
    },
    endSession() {},
  };
  return { session, counts };
};

test("socket NEW_MESSAGE into a blocked pair's private conversation", async (t) => {
  const emit = () => {
    const emitted = [];
    return { emitted, socket: { id: "s1", emit: (event, payload) => emitted.push({ event, payload }) } };
  };

  await t.test("with a conversationId: ERROR CHAT_USER_BLOCKED, the transaction aborted, nothing published or pushed", async () => {
    // ALICE blocked BOB: the blocked person and the blocker are both refused.
    for (const sender of [BOB, ALICE]) {
      const conversation = privateConversation(ALICE, BOB);
      const world = setup({ conversations: [conversation], userblocks: [block(ALICE, BOB)] });
      const { session, counts } = fakeSession();
      const restore = stub(mongoose, "startSession", async () => session);
      try {
        const { emitted, socket } = emit();
        const _id = oid();
        await sendPrivateMessage(socket, {}, { messageType: "TEXT", content: "are you there?", senderId: sender, conversationId: conversation._id, _id });
        await settle(20);
        assert.deepStrictEqual(emitted, [
          {
            event: "ERROR",
            payload: { code: "CHAT_USER_BLOCKED", message: "You can't message this person", event: "NEW_MESSAGE", conversationId: conversation._id, _id },
          },
        ]);
        assert.strictEqual(counts.aborted, 1, "Mongo keeps neither the message nor the latest-message update");
        assert.strictEqual(counts.committed, 0);
        assert.deepStrictEqual(channel("SEND_MESSAGE"), []);
        assert.deepStrictEqual(world.backend.pushes(), []);
        assert.strictEqual(world.blockQueries.length, 1);
        assert.strictEqual(logged("message_refused", { code: "CHAT_USER_BLOCKED" }).length > 0, true);
      } finally {
        restore();
        world.restore();
      }
    }
  });

  await t.test("with a receiverId (a first message): refused too, and the conversation it made goes with the abort", async () => {
    const world = setup({ userblocks: [block(BOB, ALICE)] });
    const { session, counts } = fakeSession();
    const restore = stub(mongoose, "startSession", async () => session);
    try {
      const { emitted, socket } = emit();
      await sendPrivateMessage(socket, {}, { messageType: "TEXT", content: "hi!", senderId: ALICE, receiverId: BOB });
      await settle(20);
      assert.strictEqual(emitted.length, 1);
      assert.strictEqual(emitted[0].payload.code, "CHAT_USER_BLOCKED");
      assert.strictEqual(emitted[0].payload.event, "NEW_MESSAGE");
      assert.strictEqual(emitted[0].payload.conversationId, null);
      assert.strictEqual(counts.aborted, 1);
      assert.strictEqual(counts.committed, 0);
      assert.deepStrictEqual(channel("SEND_MESSAGE"), []);
      assert.deepStrictEqual(world.backend.pushes(), []);
    } finally {
      restore();
      world.restore();
    }
  });

  await t.test("unblocked: stored, published and pushed as before", async () => {
    const conversation = privateConversation(ALICE, BOB);
    const world = setup({ conversations: [conversation], userblocks: [block(ALICE, CAROL)] });
    const { session, counts } = fakeSession();
    const restore = stub(mongoose, "startSession", async () => session);
    try {
      const { emitted, socket } = emit();
      await sendPrivateMessage(socket, {}, { messageType: "TEXT", content: "hello", senderId: ALICE, conversationId: conversation._id });
      await settle(20);
      assert.deepStrictEqual(emitted, []);
      assert.strictEqual(counts.committed, 1);
      assert.strictEqual(channel("SEND_MESSAGE").length, 1);
      const [push] = world.backend.pushes();
      assert.deepStrictEqual(push.recipientIds, [BOB]);
    } finally {
      restore();
      world.restore();
    }
  });

  await t.test("an order's conversation between a blocked pair still sends and pushes", async () => {
    const conversation = orderConversation(ALICE, BOB);
    const world = setup({ conversations: [conversation], userblocks: [block(ALICE, BOB)] });
    const { session, counts } = fakeSession();
    const restore = stub(mongoose, "startSession", async () => session);
    try {
      const { emitted, socket } = emit();
      await sendPrivateMessage(socket, {}, { messageType: "TEXT", content: "delivered", senderId: BOB, conversationId: conversation._id });
      await settle(20);
      assert.deepStrictEqual(emitted, []);
      assert.strictEqual(counts.committed, 1);
      assert.strictEqual(world.backend.pushes().length, 1);
      assert.strictEqual(world.blockQueries.length, 0);
    } finally {
      restore();
      world.restore();
    }
  });

  await t.test("over a real socket: the sender's client gets the ERROR", async () => {
    const conversation = privateConversation(ALICE, BOB);
    const world = setup({ conversations: [conversation], userblocks: [block(BOB, ALICE)] });
    const { session } = fakeSession();
    const restore = stub(mongoose, "startSession", async () => session);
    const socketServer = await harness.startServer({ mode: "enforce", deps: { sendPrivateMessage } });
    try {
      socketServer.setMembers(conversation._id, [ALICE, BOB]);
      const alice = await socketServer.userClient(ALICE);
      const errors = collect(alice, "ERROR");
      alice.emit("NEW_MESSAGE", { _id: oid(), messageType: "TEXT", content: "hey", conversationId: conversation._id });
      await until(() => errors.length > 0);
      assert.strictEqual(errors[0].code, "CHAT_USER_BLOCKED");
      assert.strictEqual(errors[0].conversationId, conversation._id);
      assert.deepStrictEqual(channel("SEND_MESSAGE"), []);
    } finally {
      await socketServer.close();
      restore();
      world.restore();
    }
  });
});

// ---------------------------------------------------------------- POST /conversations/private

test("POST /conversations/private between a blocked pair", async (t) => {
  const open = (as, body) => request(port, "POST", "/v1/api/conversations/private", { as, body });

  await t.test("403 CHAT_USER_BLOCKED, the same answer both ways, one findOne", async () => {
    const world = setup({ conversations: [privateConversation(ALICE, BOB)], userblocks: [block(ALICE, BOB)] });
    try {
      const fromBlocker = await open(ALICE, { receiverId: BOB });
      const fromBlocked = await open(BOB, { receiverId: ALICE });
      for (const res of [fromBlocker, fromBlocked]) {
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, "CHAT-403");
        assert.strictEqual(res.body.errors.code, "CHAT_USER_BLOCKED");
        assert.strictEqual(res.body.data, undefined, "no conversation is handed back");
      }
      assert.deepStrictEqual(fromBlocker.body, fromBlocked.body);
      assert.strictEqual(world.blockQueries.length, 2);
    } finally {
      world.restore();
    }
  });

  await t.test("not blocked: answered as before", async () => {
    const conversation = privateConversation(ALICE, BOB);
    const world = setup({ conversations: [conversation], userblocks: [block(CAROL, BOB)] });
    try {
      const res = await open(ALICE, { receiverId: BOB });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data._id, conversation._id);
    } finally {
      world.restore();
    }
  });

  await t.test("with an orderId (an order's conversation): not checked", async () => {
    const conversation = orderConversation(ALICE, BOB);
    const world = setup({ conversations: [conversation], userblocks: [block(ALICE, BOB)] });
    try {
      const res = await open(ALICE, { receiverId: BOB, orderId: conversation.orderId });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data._id, conversation._id);
      assert.strictEqual(world.blockQueries.length, 0);
    } finally {
      world.restore();
    }
  });
});

// ---------------------------------------------------------------- GET /conversations

test("GET /conversations: the caller's blocks hide, being blocked does not", async (t) => {
  const list = (as, qs = "") => request(port, "GET", `/v1/api/conversations${qs}`, { as });

  await t.test("the blocker loses the private conversation; the order with the same person stays", async () => {
    const blocked = privateConversation(ALICE, BOB, { ago: 10_000 });
    const order = orderConversation(ALICE, BOB, { updatedAt: past(20_000) });
    const friend = privateConversation(ALICE, CAROL, { ago: 30_000 });
    const world = setup({ conversations: [blocked, order, friend], userblocks: [block(ALICE, BOB)] });
    try {
      const mine = await list(ALICE);
      assert.strictEqual(mine.status, 200);
      assert.deepStrictEqual(mine.body.data.map((c) => c._id), [order._id, friend._id]);
      assert.strictEqual(world.blockQueries.length, 1, "one find for the whole list");
      assert.strictEqual(world.blockQueries[0].kind, "find");

      const theirs = await list(BOB);
      assert.deepStrictEqual(theirs.body.data.map((c) => c._id), [blocked._id, order._id], "the blocked person still sees it");
    } finally {
      world.restore();
    }
  });

  await t.test("hidden conversations take no place on a page", async () => {
    const blocked = privateConversation(ALICE, BOB, { ago: 10_000 });
    const friend = privateConversation(ALICE, CAROL, { ago: 30_000 });
    const world = setup({ conversations: [blocked, friend], userblocks: [block(ALICE, BOB)] });
    try {
      const res = await list(ALICE, "?skip=0&limit=1");
      assert.deepStrictEqual(res.body.data.map((c) => c._id), [friend._id]);
    } finally {
      world.restore();
    }
  });

  await t.test("the blocked person's list records no delivery for it and tells nobody", async () => {
    const blocked = privateConversation(ALICE, BOB, { from: ALICE, ago: 10_000 });
    const friend = privateConversation(BOB, CAROL, { from: CAROL, ago: 30_000 });
    const world = setup({ conversations: [blocked, friend], userblocks: [block(ALICE, BOB)] });
    try {
      const res = await list(BOB);
      assert.deepStrictEqual(res.body.data.map((c) => c._id), [blocked._id, friend._id]);
      const notices = channel("DELIVERED");
      assert.deepStrictEqual(notices.map((n) => n.conversationId), [friend._id], "only the unblocked conversation was delivered");
      const stored = world.db.conversations.find((c) => c._id === blocked._id);
      assert.strictEqual(stored.participants.find((p) => p.user === BOB).lastDeliveredAt, undefined);
    } finally {
      world.restore();
    }
  });

  await t.test("no private conversation, no userblocks query", async () => {
    const world = setup({ conversations: [orderConversation(ALICE, BOB), companyConversation(ALICE)], userblocks: [block(ALICE, BOB)] });
    try {
      const res = await list(ALICE);
      assert.strictEqual(res.body.data.length, 2);
      assert.strictEqual(world.blockQueries.length, 0);
    } finally {
      world.restore();
    }
  });
});

// ---------------------------------------------------------------- read and GET /messages

test("PUT /message-status/read in a blocked pair's private conversation", async (t) => {
  const read = (conversationId, as) => request(port, "PUT", `/v1/api/message-status/read?conversationId=${conversationId}`, { as, body: {} });

  await t.test("the reader's own marks move (their unread count is right); nothing reaches the other side", async () => {
    const conversation = privateConversation(ALICE, BOB, { from: ALICE });
    const world = setup({ conversations: [conversation], userblocks: [block(ALICE, BOB)] });
    try {
      const res = await read(conversation._id, BOB);
      assert.strictEqual(res.status, 200, "no error");
      assert.strictEqual(res.body.data.readAllAt, null);
      const stored = world.db.conversations[0];
      const bob = stored.participants.find((p) => p.user === BOB);
      assert.ok(bob.lastReadAt, "BOB's own read mark is kept");
      assert.strictEqual(stored.latestMessageData.readAllAt, null, "ALICE's ticks do not turn read");
      const notices = channel("READ_MESSAGE");
      assert.strictEqual(notices.length, 1);
      assert.deepStrictEqual(notices[0].userIds, [BOB], "the reader's own devices only");
      assert.deepStrictEqual(channel("DELIVERED"), []);
    } finally {
      world.restore();
    }
  });

  await t.test("unblocked: the sender hears it, as before", async () => {
    const conversation = privateConversation(ALICE, BOB, { from: ALICE });
    const world = setup({ conversations: [conversation] });
    try {
      const res = await read(conversation._id, BOB);
      assert.ok(res.body.data.readAllAt);
      assert.deepStrictEqual(channel("READ_MESSAGE")[0].userIds, [BOB, ALICE]);
      assert.strictEqual(channel("DELIVERED").length, 1);
    } finally {
      world.restore();
    }
  });
});

test("GET /messages in a blocked pair's private conversation: readable, but no delivery recorded or told", async () => {
  const conversation = privateConversation(ALICE, BOB, { from: ALICE });
  const world = setup({
    conversations: [conversation],
    messages: [{ _id: oid(), conversation: conversation._id, sender: ALICE, content: "hi", messageType: "TEXT", sendAt: past(60_000) }],
    userblocks: [block(BOB, ALICE)],
  });
  try {
    const res = await request(port, "GET", `/v1/api/messages?conversationId=${conversation._id}`, { as: BOB });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.length, 1);
    assert.deepStrictEqual(channel("DELIVERED"), []);
    assert.strictEqual(world.db.conversations[0].participants.find((p) => p.user === BOB).lastDeliveredAt, undefined);
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------- AGENT messages

test("POST /agent-messages into a blocked pair's private conversation: 403 CHAT_USER_BLOCKED, nothing stored", async () => {
  const conversation = privateConversation(ALICE, BOB);
  const order = orderConversation(ALICE, BOB);
  const world = setup({ conversations: [conversation, order], userblocks: [block(BOB, ALICE)] });
  const body = (conversationId) => ({
    conversationId,
    requestedBy: ALICE,
    content: "ບັນທຶກໂດຍ Seemue AI",
    agent: { v: 1, kind: "NOTE", card: { type: "NOTE", v: 1, id: "card-note-1", createdAt: "2026-10-17T03:00:00.000Z", fallbackText: "ບັນທຶກ", text: "ບັນທຶກ" } },
  });
  try {
    const res = await request(port, "POST", "/v1/api/agent-messages", { key: KEY, body: body(conversation._id) });
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(res.body, { success: false, errors: { code: "CHAT_USER_BLOCKED", message: blocks.CHAT_USER_BLOCKED_MESSAGE } });
    assert.deepStrictEqual(world.db.messages, []);
    assert.deepStrictEqual(channel("SEND_MESSAGE"), []);

    const inOrder = await request(port, "POST", "/v1/api/agent-messages", { key: KEY, body: body(order._id) });
    assert.strictEqual(inOrder.status, 201, "an order's conversation is not affected");
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------- REACT_MESSAGE, TYPING, DELIVERED

/** A socket server whose blockedInConversation answers from `state.blocked` and counts its calls. */
const blockServer = async (state, extra = {}) =>
  harness.startServer({
    mode: "enforce",
    deps: {
      blockedInConversation: async (conversationId, userId) => {
        state.lookups.push({ conversationId, userId });
        return state.blocked;
      },
      ...extra,
    },
  });

test("REACT_MESSAGE in a blocked pair's private conversation is dropped silently", async (t) => {
  const conversationId = oid();
  const messageId = oid();
  const state = { blocked: true, lookups: [], writes: 0 };
  const socketServer = await blockServer(state, {
    findReactionTarget: async () => ({ _id: messageId, conversation: conversationId, sender: BOB, messageType: "TEXT" }),
    writeReaction: async () => {
      state.writes++;
      return { reactions: [] };
    },
  });
  t.after(() => socketServer.close());
  socketServer.setMembers(conversationId, [ALICE, BOB]);
  const alice = await socketServer.userClient(ALICE);
  const errors = collect(alice, "ERROR");

  await t.test("no ERROR, no write, no REACTION, no push", async () => {
    alice.emit("REACT_MESSAGE", { messageId, emoji: "❤️" });
    await until(() => state.lookups.length === 1);
    await settle(40);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(state.writes, 0);
    assert.deepStrictEqual(socketServer.published("REACTION"), []);
    assert.deepStrictEqual(socketServer.calls.pushes, []);
    assert.deepStrictEqual(state.lookups[0], { conversationId, userId: ALICE });
  });

  await t.test("unblocked: the reaction goes, at once", async () => {
    state.blocked = false;
    alice.emit("REACT_MESSAGE", { messageId, emoji: "👍" });
    await until(() => socketServer.published("REACTION").length === 1);
    assert.strictEqual(state.writes, 1);
    assert.strictEqual(socketServer.calls.pushes.length, 1);
  });

  await t.test("a conversation of more than two asks nobody", async () => {
    const group = oid();
    const groupMessage = oid();
    const groupServer = await blockServer(state, {
      findReactionTarget: async () => ({ _id: groupMessage, conversation: group, sender: BOB, messageType: "TEXT" }),
      writeReaction: async () => ({ reactions: [] }),
    });
    try {
      groupServer.setMembers(group, [ALICE, BOB, CAROL]);
      const client = await groupServer.userClient(ALICE);
      const before = state.lookups.length;
      client.emit("REACT_MESSAGE", { messageId: groupMessage, emoji: "😂" });
      await until(() => groupServer.published("REACTION").length === 1);
      assert.strictEqual(state.lookups.length, before);
    } finally {
      await groupServer.close();
    }
  });
});

test("TYPING in a blocked pair's private conversation is dropped silently; the answer is kept at most 5 s", async (t) => {
  assert.ok(TYPING_RULES.blockTtlMs <= 5_000);
  let clock = 1_000_000;
  const conversationId = oid();
  const state = { blocked: true, lookups: [] };
  const socketServer = await blockServer(state, { now: () => clock });
  t.after(() => socketServer.close());
  socketServer.setMembers(conversationId, [ALICE, BOB]);
  const alice = await socketServer.userClient(ALICE);
  const errors = collect(alice, "ERROR");

  await t.test("blocked: nothing published, no ERROR", async () => {
    alice.emit("TYPING", { conversationId, typing: true });
    await until(() => state.lookups.length === 1);
    await settle(40);
    assert.deepStrictEqual(socketServer.published("TYPING"), []);
    assert.deepStrictEqual(errors, []);
  });

  await t.test("within 5 s the answer is reused; after them it is asked again", async () => {
    state.blocked = false;
    clock += TYPING_RULES.blockTtlMs - 1;
    alice.emit("TYPING", { conversationId, typing: true });
    await settle(40);
    assert.strictEqual(state.lookups.length, 1, "reused");
    assert.deepStrictEqual(socketServer.published("TYPING"), []);

    clock += 2;
    alice.emit("TYPING", { conversationId, typing: true });
    await until(() => socketServer.published("TYPING").length === 1);
    assert.strictEqual(state.lookups.length, 2);
    assert.deepStrictEqual(socketServer.published("TYPING")[0].userIds, [BOB]);
  });

  await t.test("a conversation that is not one-to-one asks nobody", async () => {
    const group = oid();
    socketServer.setMembers(group, [ALICE, BOB, CAROL]);
    const before = state.lookups.length;
    clock += 10_000;
    alice.emit("TYPING", { conversationId: group, typing: true });
    await until(() => socketServer.published("TYPING").some((m) => m.conversationId === group));
    assert.strictEqual(state.lookups.length, before);
  });
});

test("DELIVERED in a blocked pair's private conversation is dropped silently: no write, no notice", async () => {
  const conversationId = oid();
  const state = { blocked: true, lookups: [] };
  const writes = [];
  const socketServer = await blockServer(state, {
    writeDelivered: async (id, userId, at) => {
      writes.push({ id, userId, at });
      return { _id: id, participants: [{ user: ALICE }, { user: BOB }], latestMessageData: { senderId: BOB, sendAt: new Date(Date.now() - 60_000) } };
    },
  });
  try {
    socketServer.setMembers(conversationId, [ALICE, BOB]);
    const alice = await socketServer.userClient(ALICE);
    const errors = collect(alice, "ERROR");
    alice.emit("DELIVERED", { conversationId });
    await until(() => state.lookups.length === 1);
    await settle(40);
    assert.deepStrictEqual(writes, []);
    assert.deepStrictEqual(socketServer.published("DELIVERED"), []);
    assert.deepStrictEqual(errors, []);
  } finally {
    await socketServer.close();
  }
});
