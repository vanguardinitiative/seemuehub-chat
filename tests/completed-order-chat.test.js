/**
 * A COMPLETED order's chat takes no more messages from its parties
 * (worktrees/CHAT-CONTRACT.md §1.10), against the compiled dist/ with no
 * Redis and no Mongo (tests/helpers/offline.js, tests/helpers/org-chat-fakes.js):
 * npm test
 *
 * The web already locked its composer on `orderStatus === "COMPLETED"`; the
 * app did not, and nothing on the server stopped it. Now:
 * - a socket NEW_MESSAGE / NEW_GROUP_MESSAGE into a COMPLETED order's chat is
 *   refused inside its transaction with ERROR ORDER_COMPLETED: nothing stored,
 *   nothing published or pushed, and no retry;
 * - POST /messages answers 403 ORDER_COMPLETED before anything is written;
 * - CANCELLED and REFUNDED orders keep an open chat;
 * - the service's own messages - order steps through POST /orders, Seemue AI's
 *   AGENT messages - are still stored in a COMPLETED order's chat.
 */
const { published, cached, stub, query } = require("./helpers/offline");
const { installStore, oid } = require("./helpers/org-chat-fakes");

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const axios = require("axios");
const { Types } = mongoose;

const router = require("../dist/routes/index.js").default;
const redis = require("../dist/config/redis.js");
const { env } = require("../dist/config/env.js");
const { conversationModel } = require("../dist/models/conversation.js");
const { messageModel } = require("../dist/models/message.js");
const { messageStatusModel } = require("../dist/models/messageStatus.js");
const { sendPrivateMessage, sendGroupMessage } = require("../dist/controllers/message/index.js");
const { isCompletedOrderChat, ORDER_COMPLETED_MESSAGE } = require("../dist/utils/order-chat.js");
const { orderStepMessage } = require("../dist/controllers/order/step-message");

const BUYER = oid();
const SELLER = oid();

const writeConflict = () =>
  Object.assign(new Error("WriteConflict error: this operation conflicted with another operation."), {
    code: 112,
    codeName: "WriteConflict",
    errorLabels: ["TransientTransactionError"],
  });

/** Console lines are expected here (the refusals); keep the JSON ones. */
const quietly = async (fn) => {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  const lines = [];
  console.log = (...args) => {
    try {
      lines.push(JSON.parse(args[0]));
    } catch {}
  };
  console.error = () => {};
  console.warn = () => {};
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
};

// ---------------------------------------------------------------- the rule

test("isCompletedOrderChat: COMPLETED only", () => {
  assert.strictEqual(isCompletedOrderChat({ orderStatus: "COMPLETED" }), true);
  for (const orderStatus of ["PENDING", "IN_PROGRESS", "DELIVERED", "DISPUTED", "CANCELLED", "REFUNDED", undefined, null, "completed"]) {
    assert.strictEqual(isCompletedOrderChat({ orderStatus }), false, String(orderStatus));
  }
  assert.strictEqual(isCompletedOrderChat(null), false);
  assert.strictEqual(isCompletedOrderChat(undefined), false);
});

// ---------------------------------------------------------------- socket sends

/**
 * Stubs Mongo, Redis and the push for the send controllers, as
 * send-transaction.test.js does. `statuses` is the order status the
 * conversation update returns, one per run of the transaction (the last one
 * repeats); `conflicts` makes that many runs fail with a write conflict first.
 */
const installSend = ({ statuses = [undefined], conflicts = 0 } = {}) => {
  const steps = [];
  const emitted = [];
  const pushes = [];
  let sessions = 0;
  let runs = 0;
  let conflictsLeft = conflicts;
  const restores = [
    stub(mongoose, "startSession", async () => {
      const n = ++sessions;
      let active = false;
      return {
        startTransaction() {
          active = true;
        },
        inTransaction: () => active,
        async commitTransaction() {
          active = false;
          steps.push(`commit#${n}`);
        },
        async abortTransaction() {
          active = false;
          steps.push(`abort#${n}`);
        },
        endSession() {},
      };
    }),
    stub(messageModel, "create", async ([doc]) => {
      steps.push(`${doc.content}:insert`);
      return [{ ...doc }];
    }),
    stub(conversationModel, "findByIdAndUpdate", async (id, change) => {
      const run = runs++;
      if (conflictsLeft-- > 0) throw writeConflict();
      return {
        _id: new Types.ObjectId(String(id)),
        conversationType: "ORDER",
        orderId: new Types.ObjectId(),
        orderStatus: statuses[Math.min(run, statuses.length - 1)],
        participants: [
          { user: new Types.ObjectId(BUYER), isMuted: false },
          { user: new Types.ObjectId(SELLER), isMuted: false },
        ],
        latestMessageData: change.latestMessageData,
      };
    }),
    stub(conversationModel, "findOne", () => query(null)),
    stub(messageModel, "findOne", () => query(null)),
    stub(messageStatusModel, "insertMany", async () => []),
    stub(redis.pub, "publish", async (channel, message) => {
      const parsed = JSON.parse(message);
      steps.push(`${parsed.messageData?.content}:publish`);
      published.push({ channel, message: parsed });
    }),
    stub(env, "BACKEND_URL", "https://api.example.test"),
    stub(env, "CHAT_INTERNAL_KEY", "test-key"),
    stub(axios, "post", async (url, body) => {
      pushes.push(body);
      return { data: { success: true } };
    }),
  ];
  const socket = { id: "socket-1", emit: (event, payload) => emitted.push({ event, payload }) };
  published.length = 0;
  return { steps, emitted, pushes, socket, sessions: () => sessions, restore: () => restores.reverse().forEach((r) => r()) };
};

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const SENDS = [
  ["NEW_MESSAGE (sendPrivateMessage)", sendPrivateMessage, "NEW_MESSAGE"],
  ["NEW_GROUP_MESSAGE (sendGroupMessage)", sendGroupMessage, "NEW_GROUP_MESSAGE"],
];

for (const [label, send, event] of SENDS) {
  test(`${label} in an order's chat`, async (t) => {
    const payload = (extra = {}) => ({ _id: oid(), messageType: "TEXT", content: "thanks", senderId: BUYER, conversationId: oid(), ...extra });

    await t.test("COMPLETED: ERROR ORDER_COMPLETED with _id and conversationId; aborted, not retried, nothing published or pushed", async () => {
      const run = installSend({ statuses: ["COMPLETED"] });
      const data = payload();
      let lines;
      try {
        lines = await quietly(() => send(run.socket, null, data));
        await settle();
      } finally {
        run.restore();
      }
      assert.deepStrictEqual(run.emitted, [
        {
          event: "ERROR",
          payload: {
            code: "ORDER_COMPLETED",
            message: "This order is completed; its chat no longer takes messages",
            event,
            conversationId: data.conversationId,
            _id: data._id,
          },
        },
      ]);
      assert.deepStrictEqual(run.steps, ["thanks:insert", "abort#1"], "the insert is rolled back with the transaction");
      assert.strictEqual(run.sessions(), 1, "a refusal is not a conflict: no second run");
      assert.deepStrictEqual(published, []);
      assert.deepStrictEqual(run.pushes, []);
      const refused = lines.filter((line) => line?.msg === "message_refused");
      assert.deepStrictEqual(refused, [
        { msg: "message_refused", event, code: "ORDER_COMPLETED", socketId: "socket-1", userId: BUYER, conversationId: data.conversationId },
      ]);
      assert.ok(!lines.some((line) => line?.msg === "message_send_retry"));
    });

    await t.test("an order that completes while the send retries a conflict: refused on the run that sees it", async () => {
      const run = installSend({ conflicts: 1, statuses: ["IN_PROGRESS", "COMPLETED"] });
      const data = payload();
      try {
        await quietly(() => send(run.socket, null, data));
        await settle();
      } finally {
        run.restore();
      }
      assert.strictEqual(run.sessions(), 2);
      assert.deepStrictEqual(run.emitted.map((e) => e.payload.code), ["ORDER_COMPLETED"]);
      assert.ok(!run.steps.some((step) => step.startsWith("commit")));
      assert.deepStrictEqual(published, []);
    });

    for (const status of ["CANCELLED", "REFUNDED", "DELIVERED", undefined]) {
      await t.test(`${status ?? "no order status"}: stored and published as before`, async () => {
        const run = installSend({ statuses: [status] });
        try {
          await quietly(() => send(run.socket, null, payload({ content: "still open" })));
          await settle();
        } finally {
          run.restore();
        }
        assert.deepStrictEqual(run.emitted, [], "no ERROR");
        assert.deepStrictEqual(run.steps, ["still open:insert", "commit#1", "still open:publish"]);
        assert.strictEqual(published.filter((p) => p.channel === "SEND_MESSAGE").length, 1);
      });
    }
  });
}

// ---------------------------------------------------------------- REST and the service's own messages

const app = express();
app.use(express.json());
app.use("/v1/api", router);

const KEY = "test-chat-internal-key";
const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET_KEY, { expiresIn: "1h" });
const request = (port, method, url, { key, as, body } = {}) =>
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

/** An order conversation between BUYER and SELLER, as the backend stores it. */
const orderConversation = (orderStatus) => ({
  _id: oid(),
  conversationType: "ORDER",
  orderId: oid(),
  orderStatus,
  isOrderActive: orderStatus !== "COMPLETED" && orderStatus !== "CANCELLED",
  participants: [
    { user: BUYER, userType: "USER", isMuted: false },
    { user: SELLER, userType: "USER", isMuted: false },
  ],
  latestMessageData: { senderId: SELLER, messageId: oid(), messageType: "TEXT", content: "Order ສຳເລັດແລ້ວ", sendAt: new Date(Date.now() - 60_000), readAllAt: null, isDeleted: false },
  createdAt: new Date(Date.now() - 120_000),
  updatedAt: new Date(Date.now() - 60_000),
});

/** An in-memory store seeded with `conversation`, the key set; `restore` puts everything back. */
const setup = (conversation) => {
  published.length = 0;
  cached.clear();
  const store = installStore({ conversations: [conversation] });
  const restores = [
    stub(env, "CHAT_INTERNAL_KEY", KEY),
    stub(env, "BACKEND_URL", "https://api.test"),
    stub(env, "ORG_CHAT_ENABLED", "false"),
    stub(axios, "post", async () => ({ data: { success: true } })),
  ];
  return { ...store, restore: () => (restores.reverse().forEach((undo) => undo()), store.restore()) };
};

const conversationIn = (world, id) => world.db.conversations.find((row) => row._id === id);

let server;
let port;
test.before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  port = server.address().port;
});
test.after(() => server.close());

test("POST /messages in an order's chat", async (t) => {
  await t.test("COMPLETED: 403 ORDER_COMPLETED, nothing stored, the conversation untouched", async () => {
    const conversation = orderConversation("COMPLETED");
    const world = setup(conversation);
    try {
      const before = JSON.stringify(conversationIn(world, conversation._id));
      for (const as of [BUYER, SELLER]) {
        const res = await request(port, "POST", "/v1/api/messages", { as, body: { conversationId: conversation._id, body: "one more thing" } });
        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(res.body, { success: false, errors: { code: "ORDER_COMPLETED", message: ORDER_COMPLETED_MESSAGE } });
      }
      assert.strictEqual(world.db.messages.length, 0);
      assert.strictEqual(JSON.stringify(conversationIn(world, conversation._id)), before);
      assert.deepStrictEqual(published, []);
    } finally {
      world.restore();
    }
  });

  await t.test("a stranger still gets 404, not the order's state", async () => {
    const conversation = orderConversation("COMPLETED");
    const world = setup(conversation);
    try {
      const res = await request(port, "POST", "/v1/api/messages", { as: oid(), body: { conversationId: conversation._id, body: "hi" } });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.errors.code, "CONVERSATION_NOT_FOUND");
    } finally {
      world.restore();
    }
  });

  for (const status of ["CANCELLED", "REFUNDED", "IN_PROGRESS"]) {
    await t.test(`${status}: 201, stored`, async () => {
      const conversation = orderConversation(status);
      const world = setup(conversation);
      try {
        const res = await request(port, "POST", "/v1/api/messages", { as: BUYER, body: { conversationId: conversation._id, body: "still here" } });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(world.db.messages.length, 1);
        assert.strictEqual(world.db.messages[0].content, "still here");
        assert.strictEqual(conversationIn(world, conversation._id).latestMessageData.content, "still here");
      } finally {
        world.restore();
      }
    });
  }
});

test("the service's own messages still reach a COMPLETED order's chat", async (t) => {
  await t.test("POST /orders: the order step is stored, SEND_MESSAGE and ORDER go out", async () => {
    const conversation = orderConversation("COMPLETED");
    const world = setup(conversation);
    try {
      let res;
      await quietly(async () => {
        res = await request(port, "POST", "/v1/api/orders", {
          key: KEY,
          body: {
            ...JSON.parse(JSON.stringify(conversation)),
            orderSender: BUYER,
            latestMessageData: { ...conversation.latestMessageData, orderStep: "COMPLETED" },
          },
        });
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(world.db.messages.length, 1);
      const [step] = world.db.messages;
      assert.strictEqual(step.isOrderMessage, true);
      assert.strictEqual(step.orderStep, "COMPLETED");
      assert.strictEqual(step.content, orderStepMessage("COMPLETED"));
      assert.strictEqual(String(step.sender), BUYER);
      assert.deepStrictEqual(published.map((p) => p.channel), ["SEND_MESSAGE", "ORDER"]);
    } finally {
      world.restore();
    }
  });

  await t.test("POST /agent-messages: Seemue AI's card is stored and published", async () => {
    const conversation = orderConversation("COMPLETED");
    const world = setup(conversation);
    try {
      let res;
      await quietly(async () => {
        res = await request(port, "POST", "/v1/api/agent-messages", {
          key: KEY,
          body: {
            conversationId: conversation._id,
            requestedBy: BUYER,
            content: "ສະຫຼຸບຂໍ້ຕົກລົງໂດຍ Seemue AI",
            agent: { v: 1, kind: "NOTE", card: { type: "NOTE", v: 1, id: "card-1", fallbackText: "ບັນທຶກ" } },
          },
        });
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(world.db.messages.length, 1);
      assert.strictEqual(world.db.messages[0].messageType, "AGENT");
      assert.deepStrictEqual(published.map((p) => p.channel), ["SEND_MESSAGE"]);
    } finally {
      world.restore();
    }
  });
});
