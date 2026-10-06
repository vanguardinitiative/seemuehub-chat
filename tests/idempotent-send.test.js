/**
 * A resent message is confirmed, not refused (worktrees/CHAT-CONTRACT.md
 * §1.7), against the compiled dist/ with no Redis and no Mongo
 * (tests/helpers/offline.js): npm test
 *
 * A client that never saw its NEW_MESSAGE come back resends it with the same
 * `_id`. When that `_id` is already stored as the same sender's message, the
 * insert fails with a duplicate key, the transaction is aborted, and the
 * resending socket gets the stored message on CONVERSATION_LISTENING
 * NEW_MESSAGE instead of an ERROR. Nothing is stored, published or pushed
 * again. Every other failure is still an ERROR.
 */
const { published, stub, query } = require("./helpers/offline");

const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");
const { Types } = mongoose;

const { conversationModel } = require("../dist/models/conversation.js");
const { messageModel } = require("../dist/models/message.js");
const { sendPrivateMessage, sendGroupMessage } = require("../dist/controllers/message/index.js");

const oid = () => new Types.ObjectId().toString();

const duplicateId = (id) =>
  Object.assign(new Error(`E11000 duplicate key error collection: test.messages index: _id_ dup key: { _id: ObjectId('${id}') }`), {
    code: 11000,
    keyPattern: { _id: 1 },
    keyValue: { _id: new Types.ObjectId(id) },
  });

/**
 * Stubs the session, the insert (failing with `insertError`) and the lookup
 * (answering `stored`); records the order things happened in.
 */
const install = ({ insertError, stored, lookupError } = {}) => {
  const steps = [];
  const emitted = [];
  const lookups = [];
  let active = false;
  const session = {
    startTransaction() {
      active = true;
      steps.push("start");
    },
    inTransaction() {
      return active;
    },
    async commitTransaction() {
      active = false;
      steps.push("commit");
    },
    async abortTransaction() {
      active = false;
      steps.push("abort");
    },
    endSession() {
      steps.push("end");
    },
  };
  const restores = [
    stub(mongoose, "startSession", async () => session),
    stub(messageModel, "create", async () => {
      steps.push("insert");
      throw insertError;
    }),
    stub(messageModel, "findOne", (filter) => {
      steps.push(active ? "lookup-inside-transaction" : "lookup");
      lookups.push(filter);
      if (lookupError) {
        return { lean: () => Promise.reject(lookupError) };
      }
      return query(stored ?? null);
    }),
    stub(conversationModel, "findByIdAndUpdate", async () => assert.fail("nothing is written after a failed insert")),
  ];
  const socket = { id: "socket-1", emit: (event, payload) => emitted.push({ event, payload }) };
  return { steps, emitted, lookups, socket, restore: () => restores.reverse().forEach((restore) => restore()) };
};

/** Console lines are expected here (the refusals and the message_resent line); keep the output readable. */
const quietly = async (fn) => {
  const saved = { log: console.log, error: console.error };
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
  return lines;
};

const SENDS = [
  ["NEW_MESSAGE (sendPrivateMessage)", sendPrivateMessage, "NEW_MESSAGE"],
  ["NEW_GROUP_MESSAGE (sendGroupMessage)", sendGroupMessage, "NEW_GROUP_MESSAGE"],
];

for (const [label, send, event] of SENDS) {
  test(`${label}: a resend of a stored message`, async (t) => {
    const sender = oid();
    const conversationId = oid();
    const payload = (_id) => ({ _id, messageType: "TEXT", content: "hello", senderId: sender, receiverId: oid(), conversationId });
    const storedMessage = (_id) => ({
      _id: new Types.ObjectId(_id),
      sender: new Types.ObjectId(sender),
      conversation: new Types.ObjectId(conversationId),
      messageType: "TEXT",
      content: "hello",
      sendAt: new Date("2026-10-02T01:00:00.000Z"),
      isDeleted: false,
    });

    await t.test("is confirmed with the stored message, after the transaction is aborted and the session ended, and no ERROR", async () => {
      const _id = oid();
      const stored = storedMessage(_id);
      const run = install({ insertError: duplicateId(_id), stored });
      published.length = 0;
      let lines;
      try {
        lines = await quietly(() => send(run.socket, null, payload(_id)));
      } finally {
        run.restore();
      }
      assert.deepStrictEqual(run.emitted, [
        { event: "CONVERSATION_LISTENING", payload: { type: "NEW_MESSAGE", response: JSON.parse(JSON.stringify(stored)) } },
      ]);
      // The lookup runs once the session is over (utils/transaction.ts ends it).
      assert.deepStrictEqual(run.steps, ["start", "insert", "abort", "end", "lookup"]);
      assert.strictEqual(run.lookups.length, 1);
      assert.strictEqual(String(run.lookups[0]._id), _id);
      assert.strictEqual(String(run.lookups[0].sender), sender, "only the same sender's message");
      assert.deepStrictEqual(published, [], "nothing is published again");
      const resent = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((l) => l?.msg === "message_resent");
      assert.deepStrictEqual(resent, [{ msg: "message_resent", event, socketId: "socket-1", userId: sender, _id }]);
    });

    await t.test("someone else's _id (no stored message from this sender): ERROR as before", async () => {
      const _id = oid();
      const run = install({ insertError: duplicateId(_id), stored: null });
      try {
        await quietly(() => send(run.socket, null, payload(_id)));
      } finally {
        run.restore();
      }
      assert.strictEqual(run.lookups.length, 1);
      assert.deepStrictEqual(run.emitted.map((e) => e.event), ["ERROR"]);
      assert.strictEqual(run.emitted[0].payload.code, "MESSAGE_SEND_FAILED");
      assert.strictEqual(run.emitted[0].payload.event, event);
      assert.strictEqual(run.emitted[0].payload._id, _id);
      // The lookup runs once the session is over (utils/transaction.ts ends it).
      assert.deepStrictEqual(run.steps, ["start", "insert", "abort", "end", "lookup"]);
    });

    await t.test("a duplicate on another key: ERROR, no lookup", async () => {
      const _id = oid();
      const error = Object.assign(new Error("E11000 duplicate key"), { code: 11000, keyPattern: { clientKey: 1 } });
      const run = install({ insertError: error, stored: storedMessage(_id) });
      try {
        await quietly(() => send(run.socket, null, payload(_id)));
      } finally {
        run.restore();
      }
      assert.deepStrictEqual(run.lookups, []);
      assert.deepStrictEqual(run.emitted.map((e) => e.event), ["ERROR"]);
    });

    await t.test("a duplicate without a client _id: ERROR, no lookup", async () => {
      const run = install({ insertError: duplicateId(oid()), stored: storedMessage(oid()) });
      try {
        await quietly(() => send(run.socket, null, payload(undefined)));
      } finally {
        run.restore();
      }
      assert.deepStrictEqual(run.lookups, []);
      assert.deepStrictEqual(run.emitted.map((e) => e.event), ["ERROR"]);
      assert.strictEqual(run.emitted[0].payload._id, null);
    });

    await t.test("any other failure: ERROR, no lookup", async () => {
      const _id = oid();
      const run = install({ insertError: new Error("validation failed"), stored: storedMessage(_id) });
      try {
        await quietly(() => send(run.socket, null, payload(_id)));
      } finally {
        run.restore();
      }
      assert.deepStrictEqual(run.lookups, []);
      assert.deepStrictEqual(run.emitted.map((e) => e.event), ["ERROR"]);
      assert.strictEqual(run.emitted[0].payload.message, "validation failed");
      assert.deepStrictEqual(run.steps, ["start", "insert", "abort", "end"]);
    });

    await t.test("the lookup itself fails: still the ERROR, and the session is ended", async () => {
      const _id = oid();
      const run = install({ insertError: duplicateId(_id), lookupError: new Error("lookup failed") });
      try {
        await quietly(() => send(run.socket, null, payload(_id)));
      } finally {
        run.restore();
      }
      assert.deepStrictEqual(run.emitted.map((e) => e.event), ["ERROR"]);
      assert.deepStrictEqual(run.steps, ["start", "insert", "abort", "end", "lookup"]);
    });
  });
}
