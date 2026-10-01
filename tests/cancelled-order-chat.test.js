/**
 * A cancelled order keeps its chat, against the compiled dist/ with no Redis
 * and no Mongo (tests/helpers/offline.js): npm test
 *
 * Cancelling an order syncs `orderStatus: CANCELLED` onto its conversation
 * (seemuehub-backend#39). The conversation list used to leave those out unless
 * asked, so the chat disappeared with its order and could not be reopened.
 *
 * The list cases pin the filter the handler builds. The read cases pin that
 * every other way into a conversation (the conversation, its messages, the
 * order's history, the order-chat lookup) filters on membership only, never on
 * the order's state: a filter added there later would hide cancelled chats
 * again, one endpoint at a time.
 */
const { stub, query } = require("./helpers/offline");

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");

const router = require("../dist/routes/index.js").default;
const { conversationModel } = require("../dist/models/conversation.js");
const { messageModel } = require("../dist/models/message.js");
const { messageStatusModel } = require("../dist/models/messageStatus.js");

const oid = () => new Types.ObjectId().toString();
const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET_KEY, { expiresIn: "1h" });

const app = express();
app.use(express.json());
app.use("/v1/api", router);

const listen = () => new Promise((resolve) => { const server = app.listen(0, () => resolve(server)); });
const request = (port, method, url, { token, body } = {}) =>
  new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        port,
        path: url,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

/** An order conversation as the backend leaves it after a cancel. */
const cancelledConversation = (me, other, orderId = oid()) => ({
  _id: oid(),
  conversationType: "ORDER",
  orderId,
  orderStatus: "CANCELLED",
  isOrderActive: false,
  participants: [
    { user: new Types.ObjectId(me), userType: "USER" },
    { user: new Types.ObjectId(other), userType: "USER" },
  ],
  latestMessageData: { senderId: other, messageId: oid(), content: "Order ຖືກຍົກເລີກແລ້ວ", orderStep: "CANCELLED" },
  updatedAt: new Date(),
});

/** Order fields a read path must never filter on. */
const ORDER_STATE = ["orderStatus", "isOrderActive"];

// ---------------------------------------------------------------- the list

test("GET /conversations", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const me = oid();
  const cancelled = cancelledConversation(me, oid());

  const filters = [];
  const restores = [
    stub(conversationModel, "find", (filter) => {
      filters.push(filter);
      return query([{ ...cancelled }]);
    }),
    stub(messageStatusModel, "find", () => query([])),
  ];
  const list = (search = "") => request(port, "GET", `/v1/api/conversations${search}`, { token: tokenFor(me) });

  await t.test("without orderStatus: cancelled orders are listed too", async () => {
    filters.length = 0;
    const res = await list();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(filters.length, 1);
    assert.ok(!("orderStatus" in filters[0]), `no default order filter, got ${JSON.stringify(filters[0].orderStatus)}`);
    assert.strictEqual(String(filters[0]["participants.user"]), me, "still only the caller's conversations");
    assert.deepStrictEqual(
      res.body.data.map((c) => [c._id, c.orderStatus]),
      [[cancelled._id, "CANCELLED"]]
    );
  });

  await t.test("an empty orderStatus is the same as none", async () => {
    filters.length = 0;
    assert.strictEqual((await list("?orderStatus=")).status, 200);
    assert.ok(!("orderStatus" in filters[0]));
  });

  for (const status of ["CANCELLED", "COMPLETED", "PENDING"]) {
    await t.test(`orderStatus=${status} still filters on exactly that status`, async () => {
      filters.length = 0;
      assert.strictEqual((await list(`?orderStatus=${status}`)).status, 200);
      assert.strictEqual(filters[0].orderStatus, status);
    });
  }

  await t.test("orderStatus=NOT_COMPLETE still leaves out completed and cancelled orders", async () => {
    filters.length = 0;
    assert.strictEqual((await list("?orderStatus=NOT_COMPLETE")).status, 200);
    assert.deepStrictEqual(filters[0].orderStatus, { $nin: ["COMPLETED", "CANCELLED"] });
  });

  for (const restore of restores) restore();
  server.close();
});

// ---------------------------------------------------------------- reading it

test("a cancelled order's conversation can still be read by its participants", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const me = oid();
  const other = oid();
  const conversation = cancelledConversation(me, other);
  const token = tokenFor(me);

  /** Every conversation lookup, and the membership-only filter each must be. */
  const lookups = [];
  const restores = [
    stub(conversationModel, "findOne", (filter) => {
      lookups.push(filter);
      return query(conversation);
    }),
    stub(messageModel, "find", () =>
      query([{ _id: oid(), conversation: conversation._id, content: "Order ຖືກຍົກເລີກແລ້ວ", isOrderMessage: true }])
    ),
  ];
  const assertMembershipOnly = (expectedKeys) => {
    assert.strictEqual(lookups.length, 1);
    assert.deepStrictEqual(Object.keys(lookups[0]).sort(), [...expectedKeys].sort());
    for (const field of ORDER_STATE) assert.ok(!(field in lookups[0]), `filters on ${field}`);
  };

  await t.test("GET /conversations/:id", async () => {
    lookups.length = 0;
    const res = await request(port, "GET", `/v1/api/conversations/${conversation._id}`, { token });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.orderStatus, "CANCELLED");
    assertMembershipOnly(["_id", "participants.user"]);
  });

  await t.test("GET /messages?conversationId=", async () => {
    lookups.length = 0;
    const res = await request(port, "GET", `/v1/api/messages?conversationId=${conversation._id}`, { token });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.length, 1);
    assertMembershipOnly(["_id", "participants.user"]);
  });

  await t.test("GET /messages/histories?orderId=", async () => {
    lookups.length = 0;
    const res = await request(port, "GET", `/v1/api/messages/histories?orderId=${conversation.orderId}`, { token });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.length, 1);
    assertMembershipOnly(["orderId", "participants.user"]);
  });

  await t.test("POST /conversations/private (the order screen's way in) returns it", async () => {
    lookups.length = 0;
    const res = await request(port, "POST", "/v1/api/conversations/private", {
      token,
      body: { receiverId: other, orderId: conversation.orderId },
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data._id, conversation._id);
    assert.strictEqual(res.body.data.orderStatus, "CANCELLED");
    assertMembershipOnly(["orderId", "participants"]);
  });

  for (const restore of restores) restore();
  server.close();
});
