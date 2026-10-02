/**
 * Read state (worktrees/CHAT-CONTRACT.md §1), against the compiled dist/ with
 * no Redis and no Mongo (tests/helpers/offline.js): npm test
 *
 * - PUT /message-status/read moves the reader's participants[].lastReadAt with
 *   one membership-filtered findOneAndUpdate ($max through arrayFilters,
 *   timestamps off), sets latestMessageData.readAllAt once everyone but the
 *   latest sender has read it, and publishes READ_MESSAGE to the reader (plus
 *   the sender, only when this read made it read by all).
 * - isReadFor / allOthersRead, the pure rules behind it.
 * - The READ_MESSAGE socket payload.
 * - GET /conversations and GET /conversations/:id: latestMessageData.isRead.
 */
const { published, stub, query } = require("./helpers/offline");

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
const { isReadFor, allOthersRead, participantIdOf } = require("../dist/utils/read-state.js");
const { deliverReadMessage } = require("../dist/socket/rooms.js");

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

const MINUTE = 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms);

/** A conversation as Mongo holds it: ObjectId users, string ids in latestMessageData. */
const conversationOf = ({ type = "PRIVATE", members, senderId, sendAt = ago(MINUTE), readAllAt = null, lastReadAt = {} }) => ({
  _id: new Types.ObjectId(),
  conversationType: type,
  participants: members.map((id) => ({
    user: new Types.ObjectId(id),
    userType: "USER",
    ...(lastReadAt[id] ? { lastReadAt: lastReadAt[id] } : {}),
  })),
  latestMessageData: { senderId, messageId: oid(), sendAt, readAllAt, isDeleted: false },
});

const copy = (doc) => ({
  ...doc,
  participants: doc.participants.map((participant) => ({ ...participant })),
  latestMessageData: { ...doc.latestMessageData },
});

/**
 * Stubs the PUT's writes over one in-memory conversation, applying them the
 * way Mongo would: findOneAndUpdate matches only a participant and applies the
 * $max to the arrayFilters' element; the readAllAt updateOne applies only
 * while the messageId matches and readAllAt is still null.
 */
const store = (initial) => {
  let doc = copy(initial);
  const calls = { read: [], markAll: [], messages: [], statuses: [] };
  const restores = [
    stub(conversationModel, "findOneAndUpdate", (filter, update, options) => {
      calls.read.push({ filter, update, options });
      const reader = String(filter["participants.user"]);
      const matches = String(filter._id) === String(doc._id) && doc.participants.some((p) => String(p.user) === reader);
      if (!matches) return query(null);
      const at = update.$max["participants.$[me].lastReadAt"];
      const me = String(options.arrayFilters[0]["me.user"]);
      doc.participants = doc.participants.map((p) =>
        String(p.user) === me && !(p.lastReadAt && p.lastReadAt >= at) ? { ...p, lastReadAt: at } : p
      );
      return query(copy(doc));
    }),
    stub(conversationModel, "updateOne", async (filter, update, options) => {
      calls.markAll.push({ filter, update, options });
      const latest = doc.latestMessageData;
      if (
        String(filter._id) === String(doc._id) &&
        filter["latestMessageData.messageId"] === latest.messageId &&
        filter["latestMessageData.readAllAt"] === null &&
        latest.readAllAt == null
      ) {
        doc.latestMessageData = { ...latest, readAllAt: update.$set["latestMessageData.readAllAt"] };
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }),
    stub(messageModel, "updateMany", async (filter, update, options) => {
      calls.messages.push({ filter, update, options });
      return { matchedCount: 1, modifiedCount: 1 };
    }),
    stub(messageStatusModel, "updateMany", async (filter, update) => {
      calls.statuses.push({ filter, update });
      return { matchedCount: 0, modifiedCount: 0 };
    }),
  ];
  return {
    calls,
    get doc() {
      return doc;
    },
    restore: () => restores.reverse().forEach((restore) => restore()),
  };
};

/** The READ_MESSAGE notices published since the last reset. */
const readNotices = () => published.filter((p) => p.channel === "READ_MESSAGE").map((p) => p.message);

// ---------------------------------------------------------------- PUT /message-status/read

test("PUT /message-status/read", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const put = (conversationId, reader, body) =>
    request(port, "PUT", `/v1/api/message-status/read?conversationId=${conversationId}`, {
      token: reader ? tokenFor(reader) : undefined,
      body,
    });

  await t.test("checks the input before anything is read: 401 without a token, 400 for a bad or missing id", async () => {
    const db = store(conversationOf({ members: [oid(), oid()], senderId: oid() }));
    try {
      assert.strictEqual((await put(String(db.doc._id))).status, 401);
      assert.strictEqual((await put("not-an-id", oid())).status, 400);
      const missing = await request(port, "PUT", "/v1/api/message-status/read", { token: tokenFor(oid()) });
      assert.strictEqual(missing.status, 400);
      assert.deepStrictEqual(db.calls.read, []);
    } finally {
      db.restore();
    }
  });

  await t.test("the write: membership in the filter, $max through arrayFilters, timestamps off", async () => {
    const [a, b] = [oid(), oid()];
    const db = store(conversationOf({ members: [a, b], senderId: b }));
    published.length = 0;
    try {
      const before = Date.now();
      const res = await put(String(db.doc._id), a);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(db.calls.read.length, 1);
      const { filter, update, options } = db.calls.read[0];
      assert.strictEqual(String(filter._id), String(db.doc._id));
      assert.ok(filter["participants.user"] instanceof Types.ObjectId, "membership is part of the query");
      assert.strictEqual(String(filter["participants.user"]), a);
      assert.deepStrictEqual(Object.keys(update), ["$max"], "only the read mark; no $set of anything else");
      const at = update.$max["participants.$[me].lastReadAt"];
      assert.ok(at instanceof Date && at.getTime() >= before);
      assert.strictEqual(options.arrayFilters.length, 1);
      assert.strictEqual(String(options.arrayFilters[0]["me.user"]), a);
      assert.strictEqual(options.new, true);
      assert.strictEqual(options.timestamps, false, "a read must not bump updatedAt (the list's sort key)");
      for (const call of [...db.calls.markAll, ...db.calls.messages]) {
        assert.strictEqual(call.options.timestamps, false);
      }
      assert.strictEqual(db.calls.markAll.length, 1);
      assert.deepStrictEqual(db.calls.statuses, [], "no MessageStatus writes outside groups");
    } finally {
      db.restore();
    }
  });

  await t.test("the other side reads: readAllAt is set once, and READ_MESSAGE goes to [reader, sender]", async (st) => {
    const [a, b] = [oid(), oid()];
    const conversation = conversationOf({ members: [a, b], senderId: b });
    const { messageId, sendAt } = conversation.latestMessageData;
    const db = store(conversation);
    published.length = 0;
    try {
      const res = await put(String(conversation._id), a);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.code, "CHAT-200");
      const { data } = res.body;
      assert.deepStrictEqual(Object.keys(data).sort(), ["conversationId", "lastReadAt", "readAllAt"]);
      assert.strictEqual(data.conversationId, String(conversation._id));
      assert.ok(data.readAllAt, "read by all");
      assert.strictEqual(data.readAllAt, data.lastReadAt, "both are this read's time");

      assert.strictEqual(db.calls.markAll.length, 1);
      assert.deepStrictEqual(db.calls.markAll[0].filter, {
        _id: String(conversation._id),
        "latestMessageData.messageId": messageId,
        "latestMessageData.readAllAt": null,
      });
      assert.strictEqual(db.calls.markAll[0].update.$set["latestMessageData.readAllAt"].toISOString(), data.readAllAt);

      assert.strictEqual(db.calls.messages.length, 1);
      const messages = db.calls.messages[0];
      assert.strictEqual(String(messages.filter.conversation), String(conversation._id));
      assert.strictEqual(messages.filter.readAllAt, null);
      assert.deepStrictEqual(messages.filter.sender, { $ne: a });
      assert.deepStrictEqual(messages.filter.sendAt, { $lte: sendAt });

      assert.deepStrictEqual(readNotices(), [
        { userIds: [a, b], conversationId: String(conversation._id), readerId: a, readAt: data.lastReadAt, readAllAt: data.readAllAt },
      ]);
    } finally {
      db.restore();
    }

    await st.test("then the sender opens it: nothing more is marked, and READ_MESSAGE goes to [reader] only", async () => {
      const again = store(db.doc);
      published.length = 0;
      try {
        const res = await put(String(conversation._id), b);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.data.readAllAt, db.doc.latestMessageData.readAllAt.toISOString(), "the existing readAllAt");
        assert.deepStrictEqual(again.calls.markAll, []);
        assert.deepStrictEqual(again.calls.messages, []);
        const notices = readNotices();
        assert.strictEqual(notices.length, 1);
        assert.deepStrictEqual(notices[0].userIds, [b]);
        assert.strictEqual(notices[0].readerId, b);
        assert.strictEqual(notices[0].readAllAt, res.body.data.readAllAt);
      } finally {
        again.restore();
      }
    });
  });

  await t.test("the sender reads before the other side: no readAllAt, READ_MESSAGE to [reader] only", async () => {
    const [a, b] = [oid(), oid()];
    const db = store(conversationOf({ members: [a, b], senderId: b }));
    published.length = 0;
    try {
      const res = await put(String(db.doc._id), b);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.readAllAt, null);
      assert.deepStrictEqual(db.calls.markAll, []);
      assert.deepStrictEqual(db.calls.messages, []);
      assert.deepStrictEqual(readNotices().map((n) => n.userIds), [[b]]);
    } finally {
      db.restore();
    }
  });

  await t.test("an order step posted by an admin who is not a participant: 200, no longer a 404", async () => {
    const [buyer, seller, admin] = [oid(), oid(), oid()];
    const db = store(conversationOf({ type: "ORDER", members: [buyer, seller], senderId: admin }));
    published.length = 0;
    try {
      const res = await put(String(db.doc._id), buyer);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.readAllAt, null, "the seller has not read it yet");
      assert.deepStrictEqual(readNotices().map((n) => n.userIds), [[buyer]]);

      published.length = 0;
      const second = await put(String(db.doc._id), seller);
      assert.strictEqual(second.status, 200);
      assert.ok(second.body.data.readAllAt, "both participants have read it now");
      assert.deepStrictEqual(
        readNotices().map((n) => n.userIds),
        [[seller]],
        "the admin is not a participant, so READ_MESSAGE does not go to them"
      );
    } finally {
      db.restore();
    }
  });

  await t.test("someone who is not a participant: 404, nothing written, nothing published", async () => {
    const db = store(conversationOf({ members: [oid(), oid()], senderId: oid() }));
    published.length = 0;
    const stranger = oid();
    try {
      const res = await put(String(db.doc._id), stranger);
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.code, "CHAT-404");
      assert.strictEqual(db.calls.read.length, 1);
      assert.strictEqual(String(db.calls.read[0].filter["participants.user"]), stranger, "scoped to the caller");
      assert.ok(db.doc.participants.every((p) => !p.lastReadAt), "no read mark for anyone");
      assert.deepStrictEqual(db.calls.markAll, []);
      assert.deepStrictEqual(db.calls.messages, []);
      assert.deepStrictEqual(readNotices(), []);
    } finally {
      db.restore();
    }
  });

  await t.test("a one-participant organization conversation: the participant's own message never gets readAllAt", async () => {
    const user = oid();
    const db = store(conversationOf({ members: [user], senderId: user }));
    published.length = 0;
    try {
      for (let i = 0; i < 2; i++) {
        const res = await put(String(db.doc._id), user);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.data.readAllAt, null);
      }
      assert.deepStrictEqual(db.calls.markAll, [], "nobody else is a participant: not vacuously read by all");
      assert.strictEqual(db.doc.latestMessageData.readAllAt, null);
      assert.deepStrictEqual(readNotices().map((n) => n.userIds), [[user], [user]]);
    } finally {
      db.restore();
    }
  });

  await t.test("a one-participant organization conversation: a member's message read by the participant reaches only the reader", async () => {
    const [user, member] = [oid(), oid()];
    const db = store(conversationOf({ members: [user], senderId: member }));
    published.length = 0;
    try {
      const res = await put(String(db.doc._id), user);
      assert.strictEqual(res.status, 200);
      // Everyone who can read it has: the contract's rule (§1.2) marks it.
      assert.ok(res.body.data.readAllAt);
      assert.deepStrictEqual(readNotices().map((n) => n.userIds), [[user]], "the member is not a participant");
    } finally {
      db.restore();
    }
  });

  await t.test("a group: the legacy MessageStatus receipts, and never readAllAt", async () => {
    const [a, b, c] = [oid(), oid(), oid()];
    const db = store(conversationOf({ type: "GROUP", members: [a, b, c], senderId: b, lastReadAt: { [c]: new Date() } }));
    published.length = 0;
    try {
      const res = await put(String(db.doc._id), a);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.readAllAt, null);
      assert.strictEqual(db.calls.statuses.length, 1);
      const { filter, update } = db.calls.statuses[0];
      assert.strictEqual(String(filter.conversation), String(db.doc._id));
      assert.strictEqual(String(filter.user), a);
      assert.strictEqual(filter.status, "UNREAD");
      assert.strictEqual(update.$set.status, "READ");
      assert.deepStrictEqual(db.calls.markAll, []);
      assert.deepStrictEqual(readNotices().map((n) => n.userIds), [[a]]);
    } finally {
      db.restore();
    }
  });

  await t.test("old clients: a body of {userId} or {} changes nothing, the reader is the token's user", async () => {
    const [a, b] = [oid(), oid()];
    for (const body of [{ userId: b }, {}]) {
      const db = store(conversationOf({ members: [a, b], senderId: a }));
      published.length = 0;
      try {
        const res = await put(String(db.doc._id), b, body);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(String(db.calls.read[0].filter["participants.user"]), b);
        const mine = db.doc.participants.find((p) => String(p.user) === b);
        assert.strictEqual(res.body.data.lastReadAt, mine.lastReadAt.toISOString());
        assert.ok(!db.doc.participants.find((p) => String(p.user) === a).lastReadAt);
      } finally {
        db.restore();
      }
    }
  });

  await t.test("$max: a later read mark from another device is kept and reported", async () => {
    const [a, b] = [oid(), oid()];
    const later = new Date(Date.now() + 5 * MINUTE);
    const db = store(conversationOf({ members: [a, b], senderId: b, lastReadAt: { [a]: later } }));
    published.length = 0;
    try {
      const res = await put(String(db.doc._id), a);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.lastReadAt, later.toISOString());
      assert.strictEqual(readNotices()[0].readAt, later.toISOString());
    } finally {
      db.restore();
    }
  });

  await t.test("a message that arrived since: the readAllAt update matches nothing, so nothing else is marked or told", async () => {
    const [a, b] = [oid(), oid()];
    const db = store(conversationOf({ members: [a, b], senderId: b }));
    // The stored latest message moves on between the read and the mark.
    const restore = stub(conversationModel, "updateOne", async (filter, update, options) => {
      db.calls.markAll.push({ filter, update, options });
      return { matchedCount: 0, modifiedCount: 0 };
    });
    published.length = 0;
    try {
      const res = await put(String(db.doc._id), a);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.readAllAt, null);
      assert.strictEqual(db.calls.markAll.length, 1);
      assert.deepStrictEqual(db.calls.messages, []);
      assert.deepStrictEqual(readNotices().map((n) => n.userIds), [[a]]);
    } finally {
      restore();
      db.restore();
    }
  });

  server.close();
});

// ---------------------------------------------------------------- the rules

test("participantIdOf reads every shape participants[].user comes in", () => {
  const id = oid();
  assert.strictEqual(participantIdOf({ user: new Types.ObjectId(id) }), id);
  assert.strictEqual(participantIdOf({ user: id }), id);
  assert.strictEqual(participantIdOf({ user: { _id: new Types.ObjectId(id), userName: "x" } }), id, "populated");
  assert.strictEqual(participantIdOf({ user: { _id: id } }), id, "populated, then JSON");
  assert.strictEqual(participantIdOf({ user: null }), null, "a populated user that no longer exists");
  assert.strictEqual(participantIdOf({}), null);
  assert.strictEqual(participantIdOf(null), null);
});

test("isReadFor", async (t) => {
  const [me, other] = [oid(), oid()];
  const sendAt = ago(MINUTE);
  const conv = (latest, participants) => ({ conversationType: "PRIVATE", latestMessageData: latest, participants });
  const p = (user, lastReadAt) => ({ user, ...(lastReadAt === undefined ? {} : { lastReadAt }) });

  const rows = [
    ["no latest message", conv(undefined, [p(new Types.ObjectId(me))]), undefined, true],
    ["a latest message without a sender", conv({ sendAt }, [p(new Types.ObjectId(me))]), undefined, true],
    ["I sent it", conv({ senderId: me, sendAt }, [p(new Types.ObjectId(me))]), undefined, true],
    ["the other side sent it, I never read", conv({ senderId: other, sendAt }, [p(new Types.ObjectId(me))]), undefined, false],
    ["read before it was sent", conv({ senderId: other, sendAt }, [p(new Types.ObjectId(me), ago(2 * MINUTE))]), undefined, false],
    ["read exactly when it was sent", conv({ senderId: other, sendAt }, [p(new Types.ObjectId(me), new Date(sendAt))]), undefined, true],
    ["read after it was sent", conv({ senderId: other, sendAt }, [p(new Types.ObjectId(me), new Date())]), undefined, true],
    ["read marks as ISO strings (JSON)", conv({ senderId: other, sendAt: sendAt.toISOString() }, [p(me, new Date().toISOString())]), undefined, true],
    ["a lastReadAt of null", conv({ senderId: other, sendAt }, [p(new Types.ObjectId(me), null)]), undefined, false],
    ["the legacy status says READ", conv({ senderId: other, sendAt }, [p(new Types.ObjectId(me))]), true, true],
    ["the legacy status says UNREAD", conv({ senderId: other, sendAt }, [p(new Types.ObjectId(me))]), false, false],
    ["the legacy status says UNREAD, lastReadAt covers it", conv({ senderId: other, sendAt }, [p(new Types.ObjectId(me), new Date())]), false, true],
    ["participants populated", conv({ senderId: other, sendAt }, [p({ _id: new Types.ObjectId(me), userName: "me" }, new Date())]), undefined, true],
    ["my user was populated to null", conv({ senderId: other, sendAt }, [p(null, new Date())]), undefined, false],
    ["someone else's read mark does not count", conv({ senderId: other, sendAt }, [p(new Types.ObjectId(me)), p(new Types.ObjectId(other), new Date())]), undefined, false],
    ["not a participant at all", conv({ senderId: other, sendAt }, [p(new Types.ObjectId(other), new Date())]), undefined, false],
    ["a latest message without sendAt, read once", conv({ senderId: other }, [p(new Types.ObjectId(me), new Date())]), undefined, true],
    ["a latest message without sendAt, never read", conv({ senderId: other }, [p(new Types.ObjectId(me))]), undefined, false],
  ];
  for (const [label, conversation, legacy, expected] of rows) {
    await t.test(`${label}: ${expected}`, () => {
      assert.strictEqual(isReadFor(conversation, me, legacy), expected);
    });
  }
  await t.test("no conversation at all counts as read", () => assert.strictEqual(isReadFor(null, me), true));
});

test("allOthersRead", async (t) => {
  const [a, b, c] = [oid(), oid(), oid()];
  const sendAt = ago(MINUTE);
  const now = new Date();
  const conv = (type, senderId, participants) => ({ conversationType: type, latestMessageData: { senderId, sendAt }, participants });
  const p = (user, lastReadAt) => ({ user: user === null ? null : new Types.ObjectId(user), ...(lastReadAt ? { lastReadAt } : {}) });

  const rows = [
    ["two parties, the other side read it", conv("PRIVATE", b, [p(a, now), p(b)]), true],
    ["two parties, the other side has not", conv("PRIVATE", b, [p(a), p(b, now)]), false],
    ["two parties, the other side read before it was sent", conv("PRIVATE", b, [p(a, ago(2 * MINUTE)), p(b)]), false],
    ["an ORDER: the sender is an admin, both parties read", conv("ORDER", c, [p(a, now), p(b, now)]), true],
    ["an ORDER: the sender is an admin, one party read", conv("ORDER", c, [p(a, now), p(b)]), false],
    ["one participant, who sent it", conv("PRIVATE", a, [p(a, now)]), false],
    ["one participant, an organization member sent it, read", conv("PRIVATE", c, [p(a, now)]), true],
    ["a GROUP, everyone read", conv("GROUP", b, [p(a, now), p(b, now), p(c, now)]), false],
    ["three parties, all but the sender read", conv("PRIVATE", b, [p(a, now), p(b), p(c, now)]), true],
    ["three parties, one still to read", conv("PRIVATE", b, [p(a, now), p(b), p(c)]), false],
    ["a participant whose user is null is not counted", conv("PRIVATE", b, [p(a, now), p(b), p(null)]), true],
    ["only the sender and a null user", conv("PRIVATE", b, [p(b, now), p(null)]), false],
    ["no participants", conv("PRIVATE", b, []), false],
  ];
  for (const [label, conversation, expected] of rows) {
    await t.test(`${label}: ${expected}`, () => {
      assert.strictEqual(allOthersRead(conversation), expected);
    });
  }

  await t.test("populated participants", () => {
    const populated = conv("PRIVATE", b, [
      { user: { _id: new Types.ObjectId(a), userName: "a" }, lastReadAt: now },
      { user: { _id: new Types.ObjectId(b), userName: "b" } },
    ]);
    assert.strictEqual(allOthersRead(populated), true);
  });
  await t.test("no latest sender: nothing to have read", () => {
    assert.strictEqual(allOthersRead({ conversationType: "PRIVATE", latestMessageData: { sendAt }, participants: [p(a, now)] }), false);
  });
  await t.test("no conversation", () => assert.strictEqual(allOthersRead(null), false));
});

// ---------------------------------------------------------------- the socket payload

test("READ_MESSAGE on the socket", async (t) => {
  const fakeIo = () => {
    const emitted = [];
    return { emitted, to: (rooms) => ({ emit: (event, payload) => emitted.push({ rooms, event, payload }) }) };
  };

  await t.test("goes to the published rooms, with response still the conversationId string", () => {
    const io = fakeIo();
    const conversationId = oid();
    const [reader, sender] = [oid(), oid()];
    deliverReadMessage(io, { userIds: [reader, sender], conversationId, readerId: reader, readAt: "2026-10-02T00:00:00.000Z", readAllAt: null });
    assert.deepStrictEqual(io.emitted, [
      {
        rooms: [reader, sender],
        event: "CONVERSATION_LISTENING",
        payload: { type: "READ_MESSAGE", response: conversationId, readerId: reader, readAt: "2026-10-02T00:00:00.000Z", readAllAt: null },
      },
    ]);
    assert.strictEqual(typeof io.emitted[0].payload.response, "string");
  });

  await t.test("never to everyone: no rooms, no emit", () => {
    const io = fakeIo();
    deliverReadMessage(io, { userIds: [], conversationId: oid(), readerId: oid() });
    deliverReadMessage(io, { conversationId: oid(), readerId: oid() });
    deliverReadMessage(io, { userIds: [null, ""], conversationId: oid(), readerId: oid() });
    assert.deepStrictEqual(io.emitted, []);
  });

  await t.test("a notice from an older publisher (no readerId) keeps the old shape", () => {
    const io = fakeIo();
    const conversationId = oid();
    deliverReadMessage(io, { userIds: [oid()], conversationId });
    assert.deepStrictEqual(io.emitted[0].payload, { type: "READ_MESSAGE", response: conversationId });
  });
});

// ---------------------------------------------------------------- conversation reads

test("latestMessageData.isRead on the conversation reads", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const [me, other] = [oid(), oid()];
  const token = tokenFor(me);
  const sendAt = ago(MINUTE);

  /** As the list gets them: lean, participants populated. */
  const populated = (conversation) => ({
    ...conversation,
    _id: String(conversation._id),
    updatedAt: new Date(),
    participants: conversation.participants.map((participant) => ({ ...participant, user: { _id: participant.user, userName: "u" } })),
  });
  const unread = populated(conversationOf({ members: [me, other], senderId: other, sendAt }));
  const readHere = populated(conversationOf({ members: [me, other], senderId: other, sendAt, lastReadAt: { [me]: new Date() } }));
  const readBefore = populated(conversationOf({ members: [me, other], senderId: other, sendAt, lastReadAt: { [me]: ago(2 * MINUTE) } }));
  const mine = populated(conversationOf({ members: [me, other], senderId: me, sendAt }));
  const group = populated(conversationOf({ type: "GROUP", members: [me, other], senderId: other, sendAt }));
  const empty = populated({ ...conversationOf({ members: [me, other], senderId: undefined }), latestMessageData: { isDeleted: false } });

  const statusLookups = [];
  const restores = [
    stub(conversationModel, "find", () => query([unread, readHere, readBefore, mine, group, empty].map((c) => ({ ...c, latestMessageData: { ...c.latestMessageData } })))),
    stub(messageStatusModel, "find", (filter) => {
      statusLookups.push(filter);
      return query([{ message: new Types.ObjectId(group.latestMessageData.messageId), status: "READ" }]);
    }),
  ];

  await t.test("GET /conversations: from lastReadAt, the sender, or the legacy status", async () => {
    const res = await request(port, "GET", "/v1/api/conversations", { token });
    assert.strictEqual(res.status, 200);
    const isRead = Object.fromEntries(res.body.data.map((c) => [c._id, c.latestMessageData.isRead]));
    assert.deepStrictEqual(isRead, {
      [unread._id]: false,
      [readHere._id]: true,
      [readBefore._id]: false,
      [mine._id]: true,
      [group._id]: true,
      [empty._id]: true,
    });
    assert.strictEqual(statusLookups.length, 1, "one legacy lookup for the whole page");
    assert.strictEqual(String(statusLookups[0].user), me);
  });

  await t.test("GET /conversations: participants[].lastReadAt goes out with the participants", async () => {
    const res = await request(port, "GET", "/v1/api/conversations", { token });
    const row = res.body.data.find((c) => c._id === readHere._id);
    const minePart = row.participants.find((participant) => participant.user._id === me);
    assert.strictEqual(minePart.lastReadAt, readHere.participants.find((x) => String(x.user._id) === me).lastReadAt.toISOString());
    assert.ok(!("lastReadAt" in row.participants.find((participant) => participant.user._id === other)));
  });

  for (const restore of restores) restore();

  await t.test("GET /conversations/:id: from lastReadAt, without a legacy lookup when it already settles it", async () => {
    const hydrated = new conversationModel({
      ...conversationOf({ members: [me, other], senderId: other, sendAt, lastReadAt: { [me]: new Date() } }),
    });
    let lookups = 0;
    const undo = [
      stub(conversationModel, "findOne", () => query(hydrated)),
      stub(messageStatusModel, "find", () => {
        lookups++;
        return query([]);
      }),
    ];
    try {
      const res = await request(port, "GET", `/v1/api/conversations/${hydrated._id}`, { token });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.latestMessageData.isRead, true);
      assert.strictEqual(res.body.data.latestMessageData.messageId, hydrated.latestMessageData.messageId);
      assert.ok(res.body.data.participants.find((p) => p.user === me).lastReadAt, "lastReadAt is returned");
      assert.strictEqual(lookups, 0);
    } finally {
      undo.forEach((restore) => restore());
    }
  });

  await t.test("GET /conversations/:id: unread, then the legacy status decides", async () => {
    for (const [status, expected] of [[[], false], [["READ"], true], [["UNREAD"], false]]) {
      const conversation = conversationOf({ members: [me, other], senderId: other, sendAt });
      const undo = [
        stub(conversationModel, "findOne", () => query(populated(conversation))),
        stub(messageStatusModel, "find", () =>
          query(status.map((s) => ({ message: new Types.ObjectId(conversation.latestMessageData.messageId), status: s })))
        ),
      ];
      try {
        const res = await request(port, "GET", `/v1/api/conversations/${conversation._id}`, { token });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.data.latestMessageData.isRead, expected, `legacy ${status[0] ?? "none"}`);
      } finally {
        undo.forEach((restore) => restore());
      }
    }
  });

  server.close();
});
