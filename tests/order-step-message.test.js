/**
 * Runs against the compiled dist/ with no Redis and no Mongo
 * (tests/helpers/offline.js): the line each order step leaves in a
 * conversation, and the ORDER event that announces it. A step the backend
 * sends must have Lao text here before the backend ships it, or the room keeps
 * the English fallback for good.
 */
const { published, stub } = require("./helpers/offline");

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const { Types } = require("mongoose");
const { orderStepMessage } = require("../dist/controllers/order/step-message");
const { env } = require("../dist/config/env.js");
const router = require("../dist/routes/index.js").default;
const { conversationModel } = require("../dist/models/conversation.js");
const { messageModel } = require("../dist/models/message.js");

const BACKEND_STEPS = [
  "SUBMITTED_PROPOSAL",
  "ACCEPTED_PROPOSAL",
  "REJECTED_PROPOSAL",
  "PAYMENT_SUCCESS",
  "SUBMITTED_DELIVERABLE",
  "REJECTED_DELIVERABLE",
  "COMPLETED",
  "CANCELLED",
  "ACCEPTED_ORDER",
  "AUTO_APPROVED",
  "DISPUTE_OPENED",
  "DISPUTE_RELEASED",
  "DISPUTE_REFUNDED",
];

test("every step the backend sends reads in Lao", () => {
  for (const step of BACKEND_STEPS) {
    const text = orderStepMessage(step);
    assert.ok(!text.startsWith("Order status updated"), `${step} has no Lao text`);
    assert.match(text, /[\u0E80-\u0EFF]/, `${step} is not Lao`);
  }
});

test("the new steps say what happened", () => {
  assert.match(orderStepMessage("ACCEPTED_ORDER"), /ຮັບວຽກ/);
  assert.match(orderStepMessage("AUTO_APPROVED"), /ອັດຕະໂນມັດ/);
  assert.match(orderStepMessage("DISPUTE_OPENED"), /ລາຍງານບັນຫາ/);
  assert.match(orderStepMessage("DISPUTE_REFUNDED"), /ຄືນເງິນ/);
});

test("an unknown step still says something", () => {
  assert.strictEqual(orderStepMessage("SOMETHING_NEW"), "Order status updated to SOMETHING_NEW");
});

// ---------------------------------------------------------------- the ORDER event

test("POST /orders publishes ORDER with the conversation's fresh latestMessageData (CHAT-CONTRACT.md §1.5)", async (t) => {
  const app = express();
  app.use(express.json());
  app.use("/v1/api", router);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const { port } = server.address();
  const previousKey = env.CHAT_INTERNAL_KEY;
  env.CHAT_INTERNAL_KEY = undefined;

  const post = (body) =>
    new Promise((resolve) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        { port, path: "/v1/api/orders", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
        }
      );
      req.write(payload);
      req.end();
    });

  /** The order's conversation as the backend posts it: its copy from before the step. */
  const [buyer, seller] = [new Types.ObjectId().toString(), new Types.ObjectId().toString()];
  const backendCopy = () => ({
    _id: new Types.ObjectId().toString(),
    orderId: new Types.ObjectId().toString(),
    orderSender: seller,
    conversationType: "ORDER",
    participants: [{ user: buyer, userType: "USER" }, { user: seller, userType: "USER" }],
    latestMessageData: { senderId: buyer, messageId: "the-previous-message", content: "older", orderStep: "ACCEPTED_ORDER", isDeleted: false },
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  const orderNotices = () => published.filter((p) => p.channel === "ORDER").map((p) => p.message);

  await t.test("the step's message, as stored, is the latest message in the event", async () => {
    const body = backendCopy();
    const freshUpdatedAt = new Date();
    let stored;
    const restores = [
      stub(messageModel, "create", async (doc) => (stored = { _id: new Types.ObjectId(), ...doc })),
      // findByIdAndUpdate answers a hydrated document, as mongoose does.
      stub(conversationModel, "findByIdAndUpdate", async (id, update) => {
        const doc = new conversationModel({ _id: id, participants: body.participants, ...update });
        doc.updatedAt = freshUpdatedAt;
        return doc;
      }),
    ];
    published.length = 0;
    try {
      const res = await post({ ...body, latestMessageData: { ...body.latestMessageData, orderStep: "SUBMITTED_DELIVERABLE" } });
      assert.strictEqual(res.status, 200);
      const notices = orderNotices();
      assert.strictEqual(notices.length, 1);
      const [notice] = notices;
      assert.strictEqual(notice.latestMessageData.messageId, String(stored._id), "the step's message, not the backend's previous one");
      assert.strictEqual(notice.latestMessageData.senderId, seller);
      assert.strictEqual(notice.latestMessageData.content, orderStepMessage("SUBMITTED_DELIVERABLE"));
      assert.strictEqual(notice.latestMessageData.orderStep, "SUBMITTED_DELIVERABLE");
      assert.strictEqual(notice.latestMessageData.readAllAt, null);
      assert.strictEqual(notice.updatedAt, freshUpdatedAt.toISOString());
      // Everything else is still the backend's: who hears it, and the order.
      assert.strictEqual(notice._id, body._id);
      assert.strictEqual(notice.orderId, body.orderId);
      assert.deepStrictEqual(notice.participants, body.participants);
      // The step's message itself goes out on SEND_MESSAGE first, as before.
      assert.deepStrictEqual(published.map((p) => p.channel), ["SEND_MESSAGE", "ORDER"]);
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  });

  await t.test("if storing the step fails, ORDER still goes out with the backend's copy", async () => {
    const body = backendCopy();
    const restores = [
      stub(messageModel, "create", async () => {
        throw new Error("write failed");
      }),
      stub(conversationModel, "findByIdAndUpdate", async () => assert.fail("not reached")),
    ];
    published.length = 0;
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await post(body);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(orderNotices(), [body]);
    } finally {
      console.error = originalError;
      restores.reverse().forEach((restore) => restore());
    }
  });

  await t.test("without an orderId nothing is stored and ORDER is the backend's copy", async () => {
    const body = { ...backendCopy(), orderId: undefined };
    let created = 0;
    const restore = stub(messageModel, "create", async () => void created++);
    published.length = 0;
    try {
      const res = await post(body);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(created, 0);
      assert.deepStrictEqual(orderNotices(), [JSON.parse(JSON.stringify(body))]);
    } finally {
      restore();
    }
  });

  env.CHAT_INTERNAL_KEY = previousKey;
  server.close();
});
