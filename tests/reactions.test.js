/**
 * Reactions (worktrees/CHAT-CONTRACT.md §3), against the compiled dist/ with
 * no Redis and no Mongo (tests/helpers/offline.js): npm test
 *
 * - the rules in utils/reactions.ts: the set, the pipeline, what it leaves,
 *   the socket shape, the rate window;
 * - the write (services/reactions.ts) and the membership read
 *   (utils/conversation-access.ts membersOf);
 * - REACT_MESSAGE end to end over a real socket.io server: the checks, the
 *   refusals, and REACTION reaching every participant (the reactor's other
 *   devices included) and nobody else.
 */
const { stub, query } = require("./helpers/offline");

const test = require("node:test");
const assert = require("node:assert");
const { Types } = require("mongoose");

const { messageModel } = require("../dist/models/message.js");
const { conversationModel } = require("../dist/models/conversation.js");
const reactions = require("../dist/utils/reactions.js");
const { writeReaction, findReactionTarget } = require("../dist/services/reactions.js");
const { membersOf } = require("../dist/utils/conversation-access.js");
const { deliverReaction } = require("../dist/socket/rooms.js");
const harness = require("./helpers/socket-harness");
const { collect, connected, logged, nextEvent, oid, settle, tokenFor, until } = harness;

const { REACTIONS, isReaction, reactionUpdate, applyReaction, reactionOf, reactionViews, allowInWindow, reactionTargetProblem } = reactions;

// ---------------------------------------------------------------- the rules

test("the reaction set", async (t) => {
  await t.test("six, in the contract's order", () => {
    assert.deepStrictEqual([...REACTIONS], ["👍", "❤️", "😂", "😮", "😢", "🙏"]);
  });

  await t.test("the heart is U+2764 U+FE0F, and only that heart is accepted", () => {
    assert.deepStrictEqual([...REACTIONS[1]].map((c) => c.codePointAt(0)), [0x2764, 0xfe0f]);
    assert.strictEqual(isReaction("❤️"), true);
    assert.strictEqual(isReaction("❤"), false, "the bare heart without VS16");
  });

  await t.test("anything else is not a reaction", () => {
    for (const value of ["🔥", "👍🏽", " 👍", "👍 ", "", null, undefined, 1, ["👍"], { emoji: "👍" }]) {
      assert.strictEqual(isReaction(value), false, JSON.stringify(value));
    }
  });
});

test("reactionUpdate: one pipeline stage that only rewrites reactions", async (t) => {
  const me = oid();
  const at = new Date("2026-10-02T03:00:00.000Z");

  await t.test("with an emoji: filter me out, then append my entry", () => {
    const pipeline = reactionUpdate(me, "😂", at);
    assert.strictEqual(pipeline.length, 1);
    assert.deepStrictEqual(Object.keys(pipeline[0]), ["$set"]);
    assert.deepStrictEqual(Object.keys(pipeline[0].$set), ["reactions"], "nothing but reactions: no updatedAt, no readAllAt");
    const [kept, added] = pipeline[0].$set.reactions.$concatArrays;
    assert.deepStrictEqual(kept.$filter.input, { $ifNull: ["$reactions", []] });
    assert.strictEqual(kept.$filter.as, "reaction");
    assert.strictEqual(kept.$filter.cond.$ne[0], "$$reaction.user");
    assert.ok(kept.$filter.cond.$ne[1] instanceof Types.ObjectId);
    assert.strictEqual(String(kept.$filter.cond.$ne[1]), me);
    assert.strictEqual(added.length, 1);
    assert.ok(added[0].user instanceof Types.ObjectId);
    assert.strictEqual(String(added[0].user), me);
    assert.deepStrictEqual(added[0].emoji, { $literal: "😂" });
    assert.strictEqual(added[0].at, at);
  });

  await t.test("with null: filter me out, append nothing", () => {
    const [kept, added] = reactionUpdate(me, null, at)[0].$set.reactions.$concatArrays;
    assert.strictEqual(String(kept.$filter.cond.$ne[1]), me);
    assert.deepStrictEqual(added, []);
  });
});

test("applyReaction: what the write leaves", async (t) => {
  const [me, other] = [oid(), oid()];
  const t0 = new Date("2026-10-02T01:00:00.000Z");
  const t1 = new Date("2026-10-02T02:00:00.000Z");
  const theirs = { user: new Types.ObjectId(other), emoji: "👍", at: t0 };

  await t.test("add: appended after the others", () => {
    const after = applyReaction([theirs], me, "❤️", t1);
    assert.deepStrictEqual(reactionViews(after), [
      { user: other, emoji: "👍", at: t0.toISOString() },
      { user: me, emoji: "❤️", at: t1.toISOString() },
    ]);
  });

  await t.test("replace: my old entry goes, one entry per person", () => {
    const after = applyReaction([{ user: new Types.ObjectId(me), emoji: "😮", at: t0 }, theirs], me, "🙏", t1);
    assert.deepStrictEqual(reactionViews(after).map((r) => [r.user, r.emoji]), [[other, "👍"], [me, "🙏"]]);
  });

  await t.test("the same emoji again: still one entry, with the new time", () => {
    const after = applyReaction([{ user: new Types.ObjectId(me), emoji: "👍", at: t0 }], me, "👍", t1);
    assert.deepStrictEqual(reactionViews(after), [{ user: me, emoji: "👍", at: t1.toISOString() }]);
  });

  await t.test("remove: mine goes, theirs stays; removing what is not there changes nothing", () => {
    assert.deepStrictEqual(reactionViews(applyReaction([{ user: new Types.ObjectId(me), emoji: "👍", at: t0 }, theirs], me, null, t1)).map((r) => r.user), [other]);
    assert.deepStrictEqual(reactionViews(applyReaction([theirs], me, null, t1)).map((r) => r.user), [other]);
    assert.deepStrictEqual(applyReaction(undefined, me, null, t1), []);
  });

  await t.test("reactionOf: my emoji or null", () => {
    assert.strictEqual(reactionOf([theirs, { user: new Types.ObjectId(me), emoji: "😢" }], me), "😢");
    assert.strictEqual(reactionOf([theirs], me), null);
    assert.strictEqual(reactionOf(undefined, me), null);
  });

  await t.test("reactionViews: user as a string, at as ISO, junk left out", () => {
    assert.deepStrictEqual(
      reactionViews([{ user: new Types.ObjectId(me), emoji: "👍", at: "2026-10-02T01:00:00Z" }, { user: null, emoji: "👍" }, { user: new Types.ObjectId(other) }, { user: new Types.ObjectId(other), emoji: "😂" }]),
      [
        { user: me, emoji: "👍", at: "2026-10-02T01:00:00.000Z" },
        { user: other, emoji: "😂", at: null },
      ]
    );
  });
});

test("reactionTargetProblem", () => {
  assert.strictEqual(reactionTargetProblem({ messageType: "TEXT" }), null);
  assert.strictEqual(reactionTargetProblem({ messageType: "STICKER", isDeleted: false, isOrderMessage: false }), null);
  assert.strictEqual(reactionTargetProblem({}), null, "an old message without a type is a TEXT");
  assert.strictEqual(reactionTargetProblem({ messageType: "TEXT", isDeleted: true }), "DELETED");
  assert.strictEqual(reactionTargetProblem({ messageType: "TEXT", isOrderMessage: true }), "ORDER_MESSAGE");
  assert.strictEqual(reactionTargetProblem({ messageType: "SYSTEM" }), "SERVER_MESSAGE");
  assert.strictEqual(reactionTargetProblem({ messageType: "ORDER_STATUS_CHANGE" }), "SERVER_MESSAGE");
  assert.strictEqual(reactionTargetProblem({ messageType: "ORDER_PAYMENT" }), "SERVER_MESSAGE");
});

test("allowInWindow: 10 per 10 s, refused ones not counted", () => {
  const times = [];
  for (let i = 0; i < 10; i++) assert.strictEqual(allowInWindow(times, 1000 + i, 10, 10_000), true, `event ${i + 1}`);
  assert.strictEqual(allowInWindow(times, 1010, 10, 10_000), false, "the 11th");
  assert.strictEqual(allowInWindow(times, 10_999, 10, 10_000), false, "still within 10 s of the first");
  assert.strictEqual(times.length, 10, "refusals are not recorded");
  assert.strictEqual(allowInWindow(times, 11_000, 10, 10_000), true, "the first has aged out");
  assert.strictEqual(allowInWindow(times, 11_000, 10, 10_000), false);
});

// ---------------------------------------------------------------- the reads and the write

test("writeReaction: one findOneAndUpdate with the pipeline, timestamps off, returning the list it replaced", async () => {
  const calls = [];
  const before = { _id: new Types.ObjectId(), reactions: [{ user: new Types.ObjectId(), emoji: "👍", at: new Date() }] };
  const restore = stub(messageModel, "findOneAndUpdate", (filter, update, options) => {
    calls.push({ filter, update, options });
    const chain = query(before);
    chain.select = (fields) => {
      calls.at(-1).select = fields;
      return chain;
    };
    return chain;
  });
  const updateOne = stub(messageModel, "updateOne", () => assert.fail("one write only"));
  const updateConversation = stub(conversationModel, "updateOne", () => assert.fail("the conversation is never written"));
  const findOneAndUpdateConversation = stub(conversationModel, "findOneAndUpdate", () => assert.fail("the conversation is never written"));
  const messageId = oid();
  const me = oid();
  const at = new Date();
  let result;
  try {
    result = await writeReaction(messageId, me, "❤️", at);
  } finally {
    restore();
    updateOne();
    updateConversation();
    findOneAndUpdateConversation();
  }
  assert.strictEqual(result, before);
  assert.strictEqual(calls.length, 1);
  const [{ filter, update, options, select }] = calls;
  assert.ok(filter._id instanceof Types.ObjectId);
  assert.strictEqual(String(filter._id), messageId);
  assert.deepStrictEqual(filter.isDeleted, { $ne: true }, "a message deleted since the check is left alone");
  assert.deepStrictEqual(filter.isOrderMessage, { $ne: true });
  assert.deepStrictEqual(update, reactionUpdate(me, "❤️", at));
  assert.strictEqual(options.timestamps, false, "a reaction must not bump the message's updatedAt");
  assert.strictEqual(options.returnDocument, "before");
  assert.strictEqual(select, "reactions");
});

test("findReactionTarget reads only what the checks need", async () => {
  let selected;
  const restore = stub(messageModel, "findById", (id) => {
    const chain = query({ _id: id });
    chain.select = (fields) => {
      selected = fields;
      return chain;
    };
    return chain;
  });
  try {
    await findReactionTarget(oid());
  } finally {
    restore();
  }
  assert.deepStrictEqual(selected.split(" ").sort(), ["_id", "conversation", "isDeleted", "isOrderMessage", "messageType", "sender"]);
});

test("membersOf: participants when the caller is one, else null", async (t) => {
  const [me, other] = [oid(), oid()];
  const conversationId = oid();
  const run = async (result) => {
    const filters = [];
    const restore = stub(conversationModel, "findOne", (filter) => {
      filters.push(filter);
      return query(result);
    });
    try {
      return { members: await membersOf(conversationId, me), filters };
    } finally {
      restore();
    }
  };

  await t.test("membership is part of the query", async () => {
    const { members, filters } = await run({
      participants: [
        { user: new Types.ObjectId(me), isMuted: false },
        { user: new Types.ObjectId(other), isMuted: true },
        { user: new Types.ObjectId(other), isMuted: false },
        { user: null },
      ],
    });
    assert.strictEqual(String(filters[0]._id), conversationId);
    assert.ok(filters[0]["participants.user"] instanceof Types.ObjectId);
    assert.strictEqual(String(filters[0]["participants.user"]), me);
    assert.deepStrictEqual(members, [
      { userId: me, isMuted: false },
      { userId: other, isMuted: true },
    ]);
  });

  await t.test("not a participant (or no such conversation): null", async () => {
    assert.strictEqual((await run(null)).members, null);
  });
});

test("deliverReaction never broadcasts to everyone", () => {
  const emitted = [];
  const io = { to: (rooms) => ({ emit: (event, payload) => emitted.push({ rooms, event, payload }) }) };
  deliverReaction(io, { userIds: [], conversationId: "c", messageId: "m", reactions: [] });
  deliverReaction(io, { userIds: "nope" });
  deliverReaction(io, {});
  assert.deepStrictEqual(emitted, []);
  deliverReaction(io, { userIds: ["a", "a", "", 3, "b"], conversationId: "c", messageId: "m", reactions: "junk" });
  assert.deepStrictEqual(emitted, [
    { rooms: ["a", "b"], event: "CONVERSATION_LISTENING", payload: { type: "REACTION", response: { conversationId: "c", messageId: "m", reactions: [] } } },
  ]);
});

// ---------------------------------------------------------------- REACT_MESSAGE

/** A server whose messages and reaction writes live in memory, and whose clock the test moves. */
const reactionServer = async ({ mode = "permissive" } = {}) => {
  const messages = new Map();
  const writes = [];
  const clock = { now: Date.now() };
  const server = await harness.startServer({
    mode,
    deps: {
      now: () => clock.now,
      findReactionTarget: async (messageId) => {
        const message = messages.get(messageId);
        return message ? { ...message } : null;
      },
      // The pipeline's rule (utils/reactions.ts applyReaction), applied in memory.
      writeReaction: async (messageId, userId, emoji, at) => {
        writes.push({ messageId, userId, emoji, at });
        const message = messages.get(messageId);
        if (!message || message.isDeleted || message.isOrderMessage || message.vanishBeforeWrite) return null;
        const before = { reactions: message.reactions ? [...message.reactions] : undefined };
        message.reactions = applyReaction(message.reactions, userId, emoji, at);
        return before;
      },
    },
  });
  const addMessage = (extra = {}) => {
    const message = { _id: new Types.ObjectId(), conversation: new Types.ObjectId(), sender: new Types.ObjectId(), messageType: "TEXT", isDeleted: false, isOrderMessage: false, ...extra };
    messages.set(String(message._id), message);
    return message;
  };
  return { server, messages, writes, clock, addMessage };
};

test("REACT_MESSAGE: add, replace, remove", async (t) => {
  const { server, writes, addMessage } = await reactionServer();
  const [me, author, stranger] = [oid(), oid(), oid()];
  const message = addMessage({ sender: new Types.ObjectId(author) });
  const conversationId = String(message.conversation);
  const messageId = String(message._id);
  server.setMembers(conversationId, [me, author]);

  const mine = await server.userClient(me);
  const myOtherDevice = await server.userClient(me);
  const theirs = await server.userClient(author);
  const strangers = await server.userClient(stranger);
  const heard = { mine: collect(mine, "CONVERSATION_LISTENING"), other: collect(myOtherDevice, "CONVERSATION_LISTENING"), theirs: collect(theirs, "CONVERSATION_LISTENING"), stranger: collect(strangers, "CONVERSATION_LISTENING") };
  const errors = collect(mine, "ERROR");
  const reset = () => Object.values(heard).forEach((list) => (list.length = 0));
  const latest = () => server.published("REACTION").at(-1);

  await t.test("add: one write, REACTION published to every participant, delivered to them all and to nobody else", async () => {
    mine.emit("REACT_MESSAGE", { messageId, emoji: "👍" });
    await until(() => heard.mine.length === 1 && heard.other.length === 1 && heard.theirs.length === 1);
    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual({ ...writes[0], at: undefined }, { messageId, userId: me, emoji: "👍", at: undefined });
    const notice = latest();
    assert.deepStrictEqual(notice.userIds.sort(), [me, author].sort());
    assert.strictEqual(notice.conversationId, conversationId);
    assert.strictEqual(notice.messageId, messageId);
    assert.deepStrictEqual(notice.reactions, [{ user: me, emoji: "👍", at: writes[0].at.toISOString() }]);
    const expected = { type: "REACTION", response: { conversationId, messageId, reactions: notice.reactions } };
    assert.deepStrictEqual(heard.mine[0], expected);
    assert.deepStrictEqual(heard.other[0], expected, "the reactor's other devices");
    assert.deepStrictEqual(heard.theirs[0], expected);
    await settle();
    assert.deepStrictEqual(heard.stranger, []);
    assert.deepStrictEqual(errors, []);
  });

  await t.test("replace: still one entry for me", async () => {
    reset();
    mine.emit("REACT_MESSAGE", { messageId, emoji: "❤️" });
    await until(() => heard.theirs.length === 1);
    assert.deepStrictEqual(heard.theirs[0].response.reactions.map((r) => [r.user, r.emoji]), [[me, "❤️"]]);
  });

  await t.test("the other side reacts: both entries, and my replace keeps theirs", async () => {
    reset();
    theirs.emit("REACT_MESSAGE", { messageId, emoji: "😂" });
    await until(() => heard.mine.length === 1);
    assert.deepStrictEqual(heard.mine[0].response.reactions.map((r) => [r.user, r.emoji]), [[me, "❤️"], [author, "😂"]]);
    reset();
    mine.emit("REACT_MESSAGE", { messageId, emoji: "🙏" });
    await until(() => heard.theirs.length === 1);
    assert.deepStrictEqual(heard.theirs[0].response.reactions.map((r) => [r.user, r.emoji]), [[author, "😂"], [me, "🙏"]]);
  });

  await t.test("the same emoji again (a toggle is the client's to send as null): replaced, still one entry", async () => {
    reset();
    mine.emit("REACT_MESSAGE", { messageId, emoji: "🙏" });
    await until(() => heard.theirs.length === 1);
    assert.deepStrictEqual(heard.theirs[0].response.reactions.map((r) => [r.user, r.emoji]), [[author, "😂"], [me, "🙏"]]);
  });

  await t.test("remove (null): mine goes, theirs stays", async () => {
    reset();
    mine.emit("REACT_MESSAGE", { messageId, emoji: null });
    await until(() => heard.theirs.length === 1);
    assert.deepStrictEqual(heard.theirs[0].response.reactions.map((r) => [r.user, r.emoji]), [[author, "😂"]]);
    assert.strictEqual(writes.at(-1).emoji, null);
  });

  await t.test("no other channel is published (no SEND_MESSAGE, READ_MESSAGE, ORDER)", () => {
    assert.deepStrictEqual([...new Set(server.calls.published.map((p) => p.channel))].sort(), ["REACTION", "SETUP"]);
  });

  await server.close();
});

test("REACT_MESSAGE refusals", async (t) => {
  const { server, writes, addMessage, messages, clock } = await reactionServer();
  const [me, other, stranger] = [oid(), oid(), oid()];
  const message = addMessage({ sender: new Types.ObjectId(other) });
  const messageId = String(message._id);
  server.setMembers(String(message.conversation), [me, other]);
  const client = await server.userClient(me);
  const heard = collect(client, "CONVERSATION_LISTENING");

  const refusal = async (from, payload) => {
    // Every event counts toward the 10-per-10-s limit, refused ones too: a
    // fresh window each time keeps these about the check under test.
    clock.now += 10_000;
    const error = nextEvent(from, "ERROR");
    from.emit("REACT_MESSAGE", payload);
    return error;
  };
  const nothingWritten = async (count) => {
    await settle(40);
    assert.strictEqual(writes.length, count, "nothing written");
    assert.deepStrictEqual(server.published("REACTION"), [], "nothing published");
    assert.deepStrictEqual(heard, []);
  };

  for (const [label, emoji] of [["a bare heart (no VS16)", "❤"], ["an emoji outside the six", "🔥"], ["an empty string", ""], ["no emoji at all", undefined], ["a number", 1]]) {
    await t.test(`${label}: INVALID_PAYLOAD field emoji`, async () => {
      const payload = { messageId };
      if (emoji !== undefined) payload.emoji = emoji;
      const error = await refusal(client, payload);
      assert.deepStrictEqual(
        { code: error.code, event: error.event, messageId: error.messageId, field: error.field },
        { code: "INVALID_PAYLOAD", event: "REACT_MESSAGE", messageId, field: "emoji" }
      );
      await nothingWritten(0);
    });
  }

  for (const [label, badId] of [["not an ObjectId", "nope"], ["missing", undefined], ["an object", { $ne: null }]]) {
    await t.test(`a messageId ${label}: INVALID_PAYLOAD field messageId`, async () => {
      const error = await refusal(client, { messageId: badId, emoji: "👍" });
      assert.deepStrictEqual({ code: error.code, field: error.field, messageId: error.messageId }, { code: "INVALID_PAYLOAD", field: "messageId", messageId: typeof badId === "string" ? badId : null });
      await nothingWritten(0);
    });
  }

  await t.test("a payload that is not an object: INVALID_PAYLOAD", async () => {
    assert.strictEqual((await refusal(client, "👍")).code, "INVALID_PAYLOAD");
    await nothingWritten(0);
  });

  await t.test("a non-participant: NOT_PARTICIPANT, nothing written", async () => {
    const strangerClient = await server.userClient(stranger);
    const error = await refusal(strangerClient, { messageId, emoji: "👍" });
    assert.deepStrictEqual({ code: error.code, event: error.event, messageId: error.messageId }, { code: "NOT_PARTICIPANT", event: "REACT_MESSAGE", messageId });
    await nothingWritten(0);
    assert.strictEqual(logged("reaction_refused", { userId: stranger, reason: "NOT_PARTICIPANT" }).length, 1);
  });

  await t.test("a message that does not exist: the same NOT_PARTICIPANT (nothing learned about ids)", async () => {
    const error = await refusal(client, { messageId: oid(), emoji: "👍" });
    assert.strictEqual(error.code, "NOT_PARTICIPANT");
    await nothingWritten(0);
  });

  const unreactable = [
    ["an order message", { isOrderMessage: true, messageType: "ORDER_STATUS_CHANGE" }, "ORDER_MESSAGE"],
    ["an order-typed message", { messageType: "ORDER_PAYMENT" }, "SERVER_MESSAGE"],
    ["a SYSTEM message", { messageType: "SYSTEM" }, "SERVER_MESSAGE"],
    ["a deleted message", { isDeleted: true }, "DELETED"],
  ];
  for (const [label, extra, reason] of unreactable) {
    await t.test(`${label}, for a participant: INVALID_PAYLOAD field messageId`, async () => {
      const target = addMessage({ conversation: message.conversation, ...extra });
      const error = await refusal(client, { messageId: String(target._id), emoji: "👍" });
      assert.deepStrictEqual({ code: error.code, field: error.field }, { code: "INVALID_PAYLOAD", field: "messageId" });
      await nothingWritten(0);
      assert.strictEqual(logged("reaction_refused", { messageId: String(target._id), reason }).length, 1);
    });
  }

  await t.test("deleted between the check and the write: INVALID_PAYLOAD, nothing published", async () => {
    const target = addMessage({ conversation: message.conversation, vanishBeforeWrite: true });
    const error = await refusal(client, { messageId: String(target._id), emoji: "👍" });
    assert.strictEqual(error.code, "INVALID_PAYLOAD");
    await settle(40);
    assert.strictEqual(writes.length, 1, "the guarded write ran and matched nothing");
    assert.deepStrictEqual(server.published("REACTION"), []);
    messages.delete(String(target._id));
  });

  await server.close();
});

test("REACT_MESSAGE is limited to 10 per 10 s per socket", async (t) => {
  const { server, writes, addMessage, clock } = await reactionServer();
  const me = oid();
  const message = addMessage();
  const messageId = String(message._id);
  server.setMembers(String(message.conversation), [me, oid()]);
  const client = await server.userClient(me);
  const errors = collect(client, "ERROR");

  await t.test("the 11th within 10 s: RATE_LIMITED, not written", async () => {
    for (let i = 0; i < 10; i++) {
      client.emit("REACT_MESSAGE", { messageId, emoji: i % 2 ? "👍" : null });
      clock.now += 100;
    }
    await until(() => writes.length === 10);
    client.emit("REACT_MESSAGE", { messageId, emoji: "👍" });
    await until(() => errors.length === 1);
    assert.deepStrictEqual({ code: errors[0].code, event: errors[0].event, messageId: errors[0].messageId }, { code: "RATE_LIMITED", event: "REACT_MESSAGE", messageId });
    await settle(40);
    assert.strictEqual(writes.length, 10);
  });

  await t.test("another socket of the same user has its own window", async () => {
    const second = await server.userClient(me);
    second.emit("REACT_MESSAGE", { messageId, emoji: "😮" });
    await until(() => writes.length === 11);
  });

  await t.test("once the window has passed: accepted again", async () => {
    clock.now += 10_000;
    client.emit("REACT_MESSAGE", { messageId, emoji: "😢" });
    await until(() => writes.length === 12);
    assert.strictEqual(errors.length, 1);
  });

  await server.close();
});

test("REACT_MESSAGE needs an authenticated socket", async (t) => {
  for (const mode of ["permissive", "enforce"]) {
    await t.test(`a legacy socket in ${mode} mode: AUTH_REQUIRED, logged as refused`, async () => {
      const { server, writes, addMessage } = await reactionServer({ mode });
      const message = addMessage();
      const legacy = await connected(server.client(undefined));
      const error = nextEvent(legacy, "ERROR");
      legacy.emit("REACT_MESSAGE", { messageId: String(message._id), emoji: "👍", senderId: oid() });
      assert.deepStrictEqual({ code: (await error).code, event: (await error).event }, { code: "AUTH_REQUIRED", event: "REACT_MESSAGE" });
      await settle(40);
      assert.strictEqual(writes.length, 0);
      assert.strictEqual(logged("legacy_socket", { event: "REACT_MESSAGE", socketId: legacy.id, action: "refused", mode }).length, 1);
      await server.close();
    });
  }

  await t.test("a token that has expired since the handshake: TOKEN_EXPIRED", async () => {
    const { server, writes, addMessage } = await reactionServer();
    const me = oid();
    const message = addMessage();
    server.setMembers(String(message.conversation), [me]);
    const client = await connected(server.client({ token: tokenFor(me) }));
    server.serverSocket(client).data.tokenExpiresAt = Math.floor(Date.now() / 1000) - 1;
    const error = nextEvent(client, "ERROR");
    client.emit("REACT_MESSAGE", { messageId: String(message._id), emoji: "👍" });
    assert.strictEqual((await error).code, "TOKEN_EXPIRED");
    await settle(40);
    assert.strictEqual(writes.length, 0);
    await server.close();
  });
});
