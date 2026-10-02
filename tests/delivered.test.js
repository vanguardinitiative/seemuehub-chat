/**
 * The delivered state (worktrees/CHAT-CONTRACT.md §5.1), against the compiled
 * dist/ with no Redis and no Mongo (tests/helpers/offline.js): npm test
 *
 * - the rules (utils/delivered.ts);
 * - the trigger table: the socket's DELIVERED, GET /conversations,
 *   GET /messages?conversationId= and PUT /message-status/read each move the
 *   caller's participants[].lastDeliveredAt with a $max (timestamps off), and
 *   publish DELIVERED to the other participants when that moved it past the
 *   latest message from someone else;
 * - no write when there is nothing to deliver, never backwards, never failing
 *   a GET;
 * - DELIVERED over the socket: the participant check shared with TYPING, the
 *   2 s throttle that keeps the latest upTo, the flush on disconnect.
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
const { needsDelivery, deliveryMoves, otherParticipants, withDelivered, clampUpTo, DELIVERED_INTERVAL_MS } = require("../dist/utils/delivered.js");
const { writeDelivered, DELIVERY_FIELDS } = require("../dist/services/delivered.js");
const { deliverDelivered } = require("../dist/socket/rooms.js");
const harness = require("./helpers/socket-harness");
const { collect, connected, logged, nextEvent, oid, settle, until } = harness;

const MINUTE = 60_000;
const ago = (ms) => new Date(Date.now() - ms);
const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET_KEY, { expiresIn: "1h" });

/** A conversation as Mongo holds it. `marks` maps a member to their lastDeliveredAt. */
const conversationOf = ({ members, senderId, sendAt = ago(MINUTE), marks = {}, type = "PRIVATE" }) => ({
  _id: new Types.ObjectId(),
  conversationType: type,
  participants: members.map((id) => ({ user: new Types.ObjectId(id), userType: "USER", ...(marks[id] ? { lastDeliveredAt: marks[id] } : {}) })),
  latestMessageData: { senderId, messageId: oid(), sendAt, readAllAt: null, isDeleted: false },
  updatedAt: new Date(),
});

const deliveredNotices = () => published.filter((p) => p.channel === "DELIVERED").map((p) => p.message);

// ---------------------------------------------------------------- the rules

test("needsDelivery", async (t) => {
  const [me, other] = [oid(), oid()];
  const sendAt = ago(MINUTE);
  const rows = [
    ["from the other side, never delivered", conversationOf({ members: [me, other], senderId: other, sendAt }), true],
    ["from the other side, delivered before it was sent", conversationOf({ members: [me, other], senderId: other, sendAt, marks: { [me]: ago(2 * MINUTE) } }), true],
    ["from the other side, delivered exactly then", conversationOf({ members: [me, other], senderId: other, sendAt, marks: { [me]: new Date(sendAt) } }), false],
    ["from the other side, delivered since", conversationOf({ members: [me, other], senderId: other, sendAt, marks: { [me]: new Date() } }), false],
    ["mine", conversationOf({ members: [me, other], senderId: me, sendAt }), false],
    ["no latest sender", conversationOf({ members: [me, other], senderId: undefined, sendAt }), false],
    ["not a participant", conversationOf({ members: [other], senderId: other, sendAt }), false],
    ["the other side's mark does not count", conversationOf({ members: [me, other], senderId: other, sendAt, marks: { [other]: new Date() } }), true],
  ];
  for (const [label, conversation, expected] of rows) {
    await t.test(`${label}: ${expected}`, () => assert.strictEqual(needsDelivery(conversation, me), expected));
  }
  await t.test("populated participants and ISO strings", () => {
    const conversation = {
      latestMessageData: { senderId: other, sendAt: sendAt.toISOString() },
      participants: [{ user: { _id: new Types.ObjectId(me), userName: "me" }, lastDeliveredAt: ago(2 * MINUTE).toISOString() }, { user: { _id: new Types.ObjectId(other) } }],
    };
    assert.strictEqual(needsDelivery(conversation, me), true);
  });
  await t.test("a latest message without sendAt: only while there is no mark at all", () => {
    assert.strictEqual(needsDelivery({ latestMessageData: { senderId: other }, participants: [{ user: me }] }, me), true);
    assert.strictEqual(needsDelivery({ latestMessageData: { senderId: other }, participants: [{ user: me, lastDeliveredAt: ago(MINUTE) }] }, me), false);
  });
});

test("deliveryMoves, otherParticipants, withDelivered, clampUpTo", async (t) => {
  const [me, other, third] = [oid(), oid(), oid()];
  const sendAt = ago(MINUTE);

  await t.test("deliveryMoves: past the latest message, not short of it", () => {
    const conversation = conversationOf({ members: [me, other], senderId: other, sendAt });
    assert.strictEqual(deliveryMoves(conversation, me, new Date()), true);
    assert.strictEqual(deliveryMoves(conversation, me, ago(2 * MINUTE)), false, "an upTo before the message");
    assert.strictEqual(deliveryMoves(conversationOf({ members: [me, other], senderId: other, sendAt, marks: { [me]: new Date() } }), me, new Date()), false, "already delivered");
  });

  await t.test("otherParticipants: everyone but me, once each", () => {
    const conversation = { participants: [{ user: me }, { user: new Types.ObjectId(other) }, { user: { _id: new Types.ObjectId(third) } }, { user: other }, { user: null }] };
    assert.deepStrictEqual(otherParticipants(conversation, me), [other, third]);
  });

  await t.test("withDelivered: forward only", () => {
    const earlier = ago(2 * MINUTE);
    const later = new Date();
    const conversation = conversationOf({ members: [me, other], senderId: other, sendAt, marks: { [me]: later } });
    withDelivered(conversation, me, earlier);
    assert.strictEqual(conversation.participants[0].lastDeliveredAt, later);
    const fresh = conversationOf({ members: [me, other], senderId: other, sendAt });
    withDelivered(fresh, me, later);
    assert.strictEqual(fresh.participants[0].lastDeliveredAt, later);
    assert.ok(!("lastDeliveredAt" in fresh.participants[1]), "only mine");
  });

  await t.test("clampUpTo: a valid date no later than now, else now", () => {
    const now = new Date("2026-10-02T10:00:00.000Z");
    assert.strictEqual(clampUpTo(undefined, now), now);
    assert.strictEqual(clampUpTo("not a date", now), now);
    assert.strictEqual(clampUpTo({}, now), now);
    assert.strictEqual(clampUpTo("2026-10-02T11:00:00.000Z", now), now, "the future is now");
    assert.strictEqual(clampUpTo("2026-10-02T09:00:00.000Z", now).toISOString(), "2026-10-02T09:00:00.000Z");
    assert.strictEqual(clampUpTo(Date.parse("2026-10-02T09:30:00.000Z"), now).toISOString(), "2026-10-02T09:30:00.000Z");
  });
});

test("deliverDelivered: the other participants only, never everyone", () => {
  const emitted = [];
  const io = { to: (rooms) => ({ emit: (event, payload) => emitted.push({ rooms, event, payload }) }) };
  deliverDelivered(io, { userIds: ["me"], conversationId: "c", userId: "me", deliveredAt: "t" });
  deliverDelivered(io, { userIds: [], conversationId: "c", userId: "me" });
  deliverDelivered(io, {});
  assert.deepStrictEqual(emitted, []);
  deliverDelivered(io, { userIds: ["me", "you", "you"], conversationId: "c", userId: "me", deliveredAt: "2026-10-02T00:00:00.000Z" });
  assert.deepStrictEqual(emitted, [
    { rooms: ["you"], event: "CONVERSATION_LISTENING", payload: { type: "DELIVERED", response: { conversationId: "c", userId: "me", deliveredAt: "2026-10-02T00:00:00.000Z" } } },
  ]);
});

test("writeDelivered: a membership-filtered $max, timestamps off, returning the copy from before", async () => {
  const calls = [];
  const before = conversationOf({ members: [oid(), oid()], senderId: oid() });
  const restore = stub(conversationModel, "findOneAndUpdate", (filter, update, options) => {
    calls.push({ filter, update, options });
    const chain = query(before);
    chain.select = (fields) => {
      calls.at(-1).select = fields;
      return chain;
    };
    return chain;
  });
  const [conversationId, me, at] = [oid(), oid(), new Date()];
  let result;
  try {
    result = await writeDelivered(conversationId, me, at);
  } finally {
    restore();
  }
  assert.strictEqual(result, before);
  const [{ filter, update, options, select }] = calls;
  assert.strictEqual(filter._id, conversationId);
  assert.strictEqual(String(filter["participants.user"]), me);
  assert.deepStrictEqual(update, { $max: { "participants.$[me].lastDeliveredAt": at } });
  assert.strictEqual(String(options.arrayFilters[0]["me.user"]), me);
  assert.strictEqual(options.returnDocument, "before");
  assert.strictEqual(options.timestamps, false);
  assert.strictEqual(select, DELIVERY_FIELDS);
});

// ---------------------------------------------------------------- REST triggers

const app = express();
app.use(express.json());
app.use("/v1/api", router);
const listen = () => new Promise((resolve) => { const server = app.listen(0, () => resolve(server)); });
const request = (port, method, url, token) =>
  new Promise((resolve) => {
    const req = http.request({ port, path: url, method, headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on("error", () => resolve({ status: 0, body: null }));
    req.end();
  });

/** As the list gets them: lean, participants populated. */
const populated = (conversation) => ({
  ...conversation,
  _id: String(conversation._id),
  participants: conversation.participants.map((participant) => ({ ...participant, user: { _id: participant.user, userName: "u" } })),
  latestMessageData: { ...conversation.latestMessageData },
});

test("GET /conversations records the page as delivered", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const [me, other, third] = [oid(), oid(), oid()];
  const sendAt = ago(MINUTE);

  const run = async (page, { updateMany } = {}) => {
    const writes = [];
    const restores = [
      stub(conversationModel, "find", () => query(page.map(populated))),
      stub(messageStatusModel, "find", () => query([])),
      stub(conversationModel, "updateMany", updateMany ?? (async (filter, update, options) => {
        writes.push({ filter, update, options });
        return { matchedCount: filter._id.$in.length, modifiedCount: filter._id.$in.length };
      })),
    ];
    published.length = 0;
    try {
      const res = await request(port, "GET", "/v1/api/conversations", tokenFor(me));
      return { res, writes, notices: deliveredNotices() };
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  };

  const due = conversationOf({ members: [me, other], senderId: other, sendAt });
  const dueGroupish = conversationOf({ members: [me, other, third], senderId: third, sendAt, marks: { [me]: ago(2 * MINUTE) } });
  const mine = conversationOf({ members: [me, other], senderId: me, sendAt });
  const delivered = conversationOf({ members: [me, other], senderId: other, sendAt, marks: { [me]: new Date() } });

  await t.test("one updateMany for the conversations with something to deliver, a $max with timestamps off", async () => {
    const before = Date.now();
    const { res, writes } = await run([due, mine, delivered, dueGroupish]);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(writes.length, 1);
    const [{ filter, update, options }] = writes;
    assert.deepStrictEqual(filter._id.$in.map(String).sort(), [String(due._id), String(dueGroupish._id)].sort());
    assert.strictEqual(String(filter["participants.user"]), me, "membership in the filter");
    assert.deepStrictEqual(Object.keys(update), ["$max"]);
    const at = update.$max["participants.$[me].lastDeliveredAt"];
    assert.ok(at instanceof Date && at.getTime() >= before);
    assert.strictEqual(String(options.arrayFilters[0]["me.user"]), me);
    assert.strictEqual(options.timestamps, false);
  });

  await t.test("DELIVERED to the other participants of each, never to me; the page shows the new mark", async () => {
    const { res, writes, notices } = await run([due, mine, delivered, dueGroupish]);
    const at = writes[0].update.$max["participants.$[me].lastDeliveredAt"].toISOString();
    assert.deepStrictEqual(
      notices.sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
      [
        { userIds: [other], conversationId: String(due._id), userId: me, deliveredAt: at },
        { userIds: [other, third], conversationId: String(dueGroupish._id), userId: me, deliveredAt: at },
      ].sort((a, b) => a.conversationId.localeCompare(b.conversationId))
    );
    const row = res.body.data.find((c) => c._id === String(due._id));
    assert.strictEqual(row.participants.find((p) => p.user._id === me).lastDeliveredAt, at, "the response reflects the write");
    const untouched = res.body.data.find((c) => c._id === String(delivered._id));
    assert.strictEqual(untouched.participants.find((p) => p.user._id === me).lastDeliveredAt, delivered.participants[0].lastDeliveredAt.toISOString());
  });

  await t.test("nothing to deliver: no write, no DELIVERED", async () => {
    const { res, writes, notices } = await run([mine, delivered]);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(writes, []);
    assert.deepStrictEqual(notices, []);
  });

  await t.test("a failing write never fails the GET", async () => {
    const lines = [];
    const saved = console.log;
    console.log = (line) => lines.push(line);
    let result;
    try {
      result = await run([due], { updateMany: async () => { throw new Error("mongo down"); } });
    } finally {
      console.log = saved;
    }
    assert.strictEqual(result.res.status, 200);
    assert.strictEqual(result.res.body.data.length, 1);
    assert.deepStrictEqual(result.notices, [], "nothing announced that was not written");
    assert.ok(lines.some((line) => String(line).includes('"msg":"delivered_write_failed"')));
  });

  await t.test("only the returned page: a conversation skipped by ?skip is not delivered", async () => {
    const older = { ...conversationOf({ members: [me, other], senderId: other, sendAt }), updatedAt: ago(10 * MINUTE) };
    const newer = { ...conversationOf({ members: [me, other], senderId: other, sendAt }), updatedAt: new Date() };
    const writes = [];
    const restores = [
      stub(conversationModel, "find", () => query([newer, older].map(populated))),
      stub(messageStatusModel, "find", () => query([])),
      stub(conversationModel, "updateMany", async (filter) => void writes.push(filter)),
    ];
    try {
      await request(port, "GET", "/v1/api/conversations?skip=1&limit=1", tokenFor(me));
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
    assert.deepStrictEqual(writes[0]._id.$in.map(String), [String(older._id)]);
  });

  server.close();
});

test("GET /messages?conversationId= records that conversation as delivered", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const [me, other] = [oid(), oid()];

  const run = async (conversation, { updateOne } = {}) => {
    const lookups = [];
    const writes = [];
    const restores = [
      stub(conversationModel, "findOne", (filter) => {
        const chain = query(conversation ? { ...conversation, participants: conversation.participants.map((p) => ({ ...p })) } : null);
        chain.select = (fields) => {
          lookups.push({ filter, fields });
          return chain;
        };
        return chain;
      }),
      stub(messageModel, "find", () => query([{ _id: oid(), content: "hi" }])),
      stub(conversationModel, "updateOne", updateOne ?? (async (filter, update, options) => {
        writes.push({ filter, update, options });
        return { matchedCount: 1, modifiedCount: 1 };
      })),
    ];
    published.length = 0;
    try {
      const res = await request(port, "GET", `/v1/api/messages?conversationId=${conversation ? conversation._id : oid()}`, tokenFor(me));
      return { res, lookups, writes, notices: deliveredNotices() };
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  };

  await t.test("the membership check reads what delivery needs, and the write is a $max", async () => {
    const conversation = conversationOf({ members: [me, other], senderId: other });
    const { res, lookups, writes, notices } = await run(conversation);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.length, 1);
    assert.deepStrictEqual(Object.keys(lookups[0].filter).sort(), ["_id", "participants.user"]);
    assert.strictEqual(lookups[0].fields, DELIVERY_FIELDS);
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(String(writes[0].filter._id), String(conversation._id));
    assert.strictEqual(String(writes[0].filter["participants.user"]), me);
    const at = writes[0].update.$max["participants.$[me].lastDeliveredAt"];
    assert.ok(at instanceof Date);
    assert.strictEqual(writes[0].options.timestamps, false);
    assert.deepStrictEqual(notices, [{ userIds: [other], conversationId: String(conversation._id), userId: me, deliveredAt: at.toISOString() }]);
  });

  await t.test("already delivered, or my own latest message: no write, no DELIVERED", async () => {
    for (const conversation of [
      conversationOf({ members: [me, other], senderId: other, marks: { [me]: new Date() } }),
      conversationOf({ members: [me, other], senderId: me }),
    ]) {
      const { res, writes, notices } = await run(conversation);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(writes, []);
      assert.deepStrictEqual(notices, []);
    }
  });

  await t.test("not a participant: the same 404 as before, nothing written", async () => {
    const { res, writes } = await run(null);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(writes, []);
  });

  await t.test("a failing write never fails the GET", async () => {
    const saved = console.log;
    console.log = () => {};
    let result;
    try {
      result = await run(conversationOf({ members: [me, other], senderId: other }), { updateOne: async () => { throw new Error("mongo down"); } });
    } finally {
      console.log = saved;
    }
    assert.strictEqual(result.res.status, 200);
    assert.deepStrictEqual(result.notices, []);
  });

  server.close();
});

test("PUT /message-status/read also delivers", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const [me, other] = [oid(), oid()];

  const run = async (initial) => {
    let doc = JSON.parse(JSON.stringify(initial), (key, value) => (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) ? new Date(value) : value));
    doc._id = String(initial._id);
    const calls = [];
    const restores = [
      stub(conversationModel, "findOneAndUpdate", (filter, update, options) => {
        calls.push({ filter, update, options });
        const before = { ...doc, participants: doc.participants.map((p) => ({ ...p })) };
        for (const [path, at] of Object.entries(update.$max)) {
          const field = path.replace("participants.$[me].", "");
          doc.participants = doc.participants.map((p) => (String(p.user) === me && !(p[field] && p[field] >= at) ? { ...p, [field]: at } : p));
        }
        return query(options.returnDocument === "before" ? before : doc);
      }),
      stub(conversationModel, "updateOne", async () => ({ matchedCount: 1, modifiedCount: 1 })),
      stub(messageModel, "updateMany", async () => ({ matchedCount: 0, modifiedCount: 0 })),
    ];
    published.length = 0;
    try {
      const res = await request(port, "PUT", `/v1/api/message-status/read?conversationId=${initial._id}`, tokenFor(me));
      return { res, calls, notices: deliveredNotices(), doc };
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  };

  await t.test("one update moves both marks; DELIVERED to the other side", async () => {
    const conversation = conversationOf({ members: [me, other], senderId: other });
    const { res, calls, notices, doc } = await run(conversation);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 1, "the same findOneAndUpdate");
    const at = calls[0].update.$max["participants.$[me].lastDeliveredAt"];
    assert.strictEqual(calls[0].update.$max["participants.$[me].lastReadAt"], at);
    assert.deepStrictEqual(notices, [{ userIds: [other], conversationId: String(conversation._id), userId: me, deliveredAt: at.toISOString() }]);
    assert.strictEqual(doc.participants[0].lastDeliveredAt, at);
    assert.strictEqual(res.body.data.lastReadAt, at.toISOString());
  });

  await t.test("already delivered (say, by the list): reading publishes no second DELIVERED", async () => {
    const { res, notices } = await run(conversationOf({ members: [me, other], senderId: other, marks: { [me]: new Date() } }));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(notices, []);
  });

  await t.test("my own latest message: no DELIVERED", async () => {
    const { notices } = await run(conversationOf({ members: [me, other], senderId: me }));
    assert.deepStrictEqual(notices, []);
  });

  server.close();
});

// ---------------------------------------------------------------- the socket's DELIVERED

/** A server whose conversations live in memory, with a clock and timers the test drives. */
const deliveredServer = async () => {
  // Real time: the handshake token (1 h) is checked against this clock too.
  const clock = { now: Date.now() };
  const timers = [];
  const cleared = [];
  const conversations = new Map();
  const writes = [];
  const server = await harness.startServer({
    deps: {
      now: () => clock.now,
      setTimer: (fn, ms) => {
        const timer = { fn, ms, fired: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => cleared.push(timer),
      writeDelivered: async (conversationId, userId, at) => {
        writes.push({ conversationId, userId, at });
        const conversation = conversations.get(conversationId);
        if (!conversation || !conversation.participants.some((p) => String(p.user) === userId)) return null;
        const before = { ...conversation, participants: conversation.participants.map((p) => ({ ...p })) };
        conversation.participants = conversation.participants.map((p) =>
          String(p.user) === userId && !(p.lastDeliveredAt && p.lastDeliveredAt >= at) ? { ...p, lastDeliveredAt: at } : p
        );
        return before;
      },
    },
  });
  const add = (conversation) => {
    conversations.set(String(conversation._id), conversation);
    server.setMembers(String(conversation._id), conversation.participants.map((p) => String(p.user)));
    return String(conversation._id);
  };
  const fire = () => {
    const due = timers.filter((timer) => !timer.fired && !cleared.includes(timer));
    for (const timer of due) {
      timer.fired = true;
      timer.fn();
    }
    return due.length;
  };
  return { server, clock, timers, cleared, conversations, writes, add, fire };
};

test("DELIVERED over the socket", async (t) => {
  const s = await deliveredServer();
  const [me, other, third] = [oid(), oid(), oid()];
  const sendAt = new Date(s.clock.now - MINUTE);
  const conversationId = s.add(conversationOf({ members: [me, other, third], senderId: other, sendAt }));
  const mine = await s.server.userClient(me);
  const myOtherDevice = await s.server.userClient(me);
  const theirs = await s.server.userClient(other);
  const heard = { mine: collect(mine, "CONVERSATION_LISTENING"), other: collect(myOtherDevice, "CONVERSATION_LISTENING"), theirs: collect(theirs, "CONVERSATION_LISTENING") };
  const notices = () => s.server.published("DELIVERED");

  await t.test("written as upTo, DELIVERED to the other participants (not to my devices)", async () => {
    const upTo = new Date(s.clock.now - 1_000).toISOString();
    mine.emit("DELIVERED", { conversationId, upTo });
    await until(() => heard.theirs.length === 1);
    assert.deepStrictEqual(s.writes.map((w) => [w.conversationId, w.userId, w.at.toISOString()]), [[conversationId, me, upTo]]);
    assert.deepStrictEqual(notices(), [{ userIds: [other, third], conversationId, userId: me, deliveredAt: upTo }]);
    assert.deepStrictEqual(heard.theirs[0], { type: "DELIVERED", response: { conversationId, userId: me, deliveredAt: upTo } });
    await settle(30);
    assert.deepStrictEqual(heard.mine, []);
    assert.deepStrictEqual(heard.other, []);
  });

  await t.test("within 2 s: not written yet; the latest upTo waits and is written when the 2 s are up", async () => {
    s.clock.now += 500;
    const first = new Date(s.clock.now - 300).toISOString();
    mine.emit("DELIVERED", { conversationId, upTo: first });
    await until(() => s.timers.length === 1);
    assert.strictEqual(s.timers[0].ms, DELIVERED_INTERVAL_MS - 500, "the rest of the 2 s");
    s.clock.now += 200;
    const latest = new Date(s.clock.now).toISOString();
    mine.emit("DELIVERED", { conversationId, upTo: latest });
    mine.emit("DELIVERED", { conversationId, upTo: first });
    await settle(30);
    assert.strictEqual(s.writes.length, 1, "nothing written inside the window");
    assert.strictEqual(s.timers.length, 1, "one deferred write, not one per event");
    s.clock.now += 1_300;
    assert.strictEqual(s.fire(), 1);
    await until(() => s.writes.length === 2);
    assert.strictEqual(s.writes[1].at.toISOString(), latest, "the latest upTo, not the first nor the last sent");
  });

  await t.test("$max never moves back: an older upTo writes nothing new and announces nothing", async () => {
    s.clock.now += 5_000;
    const before = notices().length;
    const stored = s.conversations.get(conversationId).participants.find((p) => String(p.user) === me).lastDeliveredAt;
    mine.emit("DELIVERED", { conversationId, upTo: new Date(s.clock.now - 10 * MINUTE).toISOString() });
    await until(() => s.writes.length === 3);
    await settle(20);
    assert.strictEqual(s.conversations.get(conversationId).participants.find((p) => String(p.user) === me).lastDeliveredAt, stored);
    assert.strictEqual(notices().length, before);
  });

  await t.test("an upTo in the future, or not a date, is now", async () => {
    s.clock.now += 5_000;
    mine.emit("DELIVERED", { conversationId, upTo: "2099-01-01T00:00:00.000Z" });
    await until(() => s.writes.length === 4);
    assert.strictEqual(s.writes[3].at.getTime(), s.clock.now);
    s.clock.now += 5_000;
    mine.emit("DELIVERED", { conversationId, upTo: "yesterday-ish" });
    await until(() => s.writes.length === 5);
    assert.strictEqual(s.writes[4].at.getTime(), s.clock.now);
    s.clock.now += 5_000;
    mine.emit("DELIVERED", { conversationId });
    await until(() => s.writes.length === 6);
    assert.strictEqual(s.writes[5].at.getTime(), s.clock.now);
  });

  await t.test("the latest message is mine: written, but nobody is told", async () => {
    const own = s.add(conversationOf({ members: [me, other], senderId: me, sendAt }));
    const before = notices().length;
    mine.emit("DELIVERED", { conversationId: own });
    await until(() => s.writes.some((w) => w.conversationId === own));
    await settle(20);
    assert.strictEqual(notices().length, before);
  });

  await s.server.close();
});

test("DELIVERED: the participant check, shared with TYPING", async (t) => {
  const s = await deliveredServer();
  const [me, other] = [oid(), oid()];
  const conversationId = s.add(conversationOf({ members: [me, other], senderId: other }));
  const client = await s.server.userClient(me);
  const lookups = () => s.server.calls.lookups.filter((l) => l.conversationId === conversationId).length;

  await t.test("TYPING then DELIVERED in the same conversation: one lookup", async () => {
    client.emit("TYPING", { conversationId, typing: true });
    await until(() => s.server.published("TYPING").length === 1);
    client.emit("DELIVERED", { conversationId });
    await until(() => s.writes.length === 1);
    assert.strictEqual(lookups(), 1);
  });

  await t.test("not a participant: NOT_PARTICIPANT, nothing written", async () => {
    const stranger = await s.server.userClient(oid());
    const error = nextEvent(stranger, "ERROR");
    stranger.emit("DELIVERED", { conversationId });
    assert.deepStrictEqual(
      { code: (await error).code, event: (await error).event, conversationId: (await error).conversationId },
      { code: "NOT_PARTICIPANT", event: "DELIVERED", conversationId }
    );
    await settle(20);
    assert.strictEqual(s.writes.length, 1);
  });

  await t.test("a conversationId that is not an ObjectId: INVALID_PAYLOAD", async () => {
    for (const payload of [{ conversationId: "nope" }, {}, "x"]) {
      const error = nextEvent(client, "ERROR");
      client.emit("DELIVERED", payload);
      assert.deepStrictEqual({ code: (await error).code, event: (await error).event }, { code: "INVALID_PAYLOAD", event: "DELIVERED" });
    }
    assert.strictEqual(s.writes.length, 1);
  });

  await t.test("a legacy socket: AUTH_REQUIRED", async () => {
    const legacy = await connected(s.server.client(undefined));
    const error = nextEvent(legacy, "ERROR");
    legacy.emit("DELIVERED", { conversationId, userId: me });
    assert.strictEqual((await error).code, "AUTH_REQUIRED");
    assert.strictEqual(logged("legacy_socket", { event: "DELIVERED", socketId: legacy.id, action: "refused" }).length, 1);
    await settle(20);
    assert.strictEqual(s.writes.length, 1);
  });

  await s.server.close();
});

test("DELIVERED: a write still waiting when the socket disconnects is made then", async () => {
  const s = await deliveredServer();
  const [me, other] = [oid(), oid()];
  const conversationId = s.add(conversationOf({ members: [me, other], senderId: other, sendAt: new Date(s.clock.now - 10 * MINUTE) }));
  const client = await s.server.userClient(me);
  const theirs = await s.server.userClient(other);
  const heard = collect(theirs, "CONVERSATION_LISTENING");

  client.emit("DELIVERED", { conversationId, upTo: new Date(s.clock.now - 11 * MINUTE).toISOString() });
  await until(() => s.writes.length === 1);
  s.clock.now += 100;
  const waiting = new Date(s.clock.now).toISOString();
  client.emit("DELIVERED", { conversationId, upTo: waiting });
  await until(() => s.timers.length === 1);
  client.disconnect();
  await until(() => s.writes.length === 2);
  assert.deepStrictEqual(s.cleared, [s.timers[0]], "the timer is cleared, not left to fire");
  assert.strictEqual(s.writes[1].at.toISOString(), waiting);
  await until(() => heard.length === 1);
  assert.deepStrictEqual(heard[0].response, { conversationId, userId: me, deliveredAt: waiting });
  assert.strictEqual(s.fire(), 0);
  await s.server.close();
});
