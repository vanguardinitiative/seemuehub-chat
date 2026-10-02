/**
 * The typing indicator (worktrees/CHAT-CONTRACT.md §4.1), against the
 * compiled dist/ over a real socket.io server with Redis and Mongo replaced
 * (tests/helpers/socket-harness.js): npm test
 *
 * - the per-socket rules (socket/typing.ts): membership cache, throttle;
 * - TYPING end to end: recipients are the other participants only, the
 *   participant check is cached, one per second per conversation with a
 *   typing:false always let through after a true, nothing written anywhere;
 * - disconnect sends typing:false wherever the socket was still typing.
 */
const test = require("node:test");
const assert = require("node:assert");

const { TYPING_RULES, typingPasses, membershipExpired, newTypingEntry, makeRoomForTyping, stillTyping } = require("../dist/socket/typing.js");
const { deliverTyping } = require("../dist/socket/rooms.js");
const harness = require("./helpers/socket-harness");
const { collect, connected, logged, nextEvent, oid, settle, tokenFor, until } = harness;

// ---------------------------------------------------------------- the rules

test("typingPasses: one a second, a false after a true always", () => {
  const entry = newTypingEntry();
  assert.strictEqual(typingPasses(entry, true, 0), true, "the first one");
  Object.assign(entry, { lastForwardedAt: 0, typing: true });
  assert.strictEqual(typingPasses(entry, true, 999), false);
  assert.strictEqual(typingPasses(entry, true, 1000), true);
  assert.strictEqual(typingPasses(entry, false, 1), true, "false after a forwarded true, at once");
  Object.assign(entry, { lastForwardedAt: 1, typing: false });
  assert.strictEqual(typingPasses(entry, false, 2), false, "a second false is just extra");
  assert.strictEqual(typingPasses(entry, true, 2), false, "and so is a true within the second");
  assert.strictEqual(typingPasses(entry, true, 1001), true);
});

test("membershipExpired: 10 minutes for a participant, 1 minute for a refusal", () => {
  const entry = newTypingEntry();
  assert.strictEqual(membershipExpired(entry, 0), true, "never looked up");
  Object.assign(entry, { member: true, checkedAt: 0 });
  assert.strictEqual(TYPING_RULES.memberTtlMs, 600_000);
  assert.strictEqual(membershipExpired(entry, 599_999), false);
  assert.strictEqual(membershipExpired(entry, 600_000), true);
  Object.assign(entry, { member: false, checkedAt: 0 });
  assert.strictEqual(membershipExpired(entry, 59_999), false);
  assert.strictEqual(membershipExpired(entry, 60_000), true);
});

test("makeRoomForTyping keeps a socket's map bounded, and keeps what is still typing", () => {
  const entries = new Map();
  for (let i = 0; i < TYPING_RULES.maxConversations; i++) {
    entries.set(`c${i}`, { ...newTypingEntry(), typing: i < 3 });
  }
  makeRoomForTyping(entries);
  assert.strictEqual(entries.size, TYPING_RULES.maxConversations - 1);
  assert.ok(entries.has("c0") && entries.has("c1") && entries.has("c2"), "typing entries are kept");
  assert.ok(!entries.has("c3"), "the oldest idle one goes");
  const small = new Map([["a", newTypingEntry()]]);
  makeRoomForTyping(small);
  assert.strictEqual(small.size, 1, "nothing goes while there is room");
});

test("stillTyping: only conversations last reported true, with someone to tell", () => {
  const entries = new Map([
    ["a", { ...newTypingEntry(), member: true, typing: true, others: ["x"] }],
    ["b", { ...newTypingEntry(), member: true, typing: false, others: ["x"] }],
    ["c", { ...newTypingEntry(), member: true, typing: true, others: [] }],
    ["d", { ...newTypingEntry(), member: false, typing: true, others: ["x"] }],
  ]);
  assert.deepStrictEqual(stillTyping(entries), [{ conversationId: "a", others: ["x"] }]);
  assert.deepStrictEqual(stillTyping(undefined), []);
});

test("deliverTyping: the other participants only, never everyone", () => {
  const emitted = [];
  const io = { to: (rooms) => ({ emit: (event, payload) => emitted.push({ rooms, event, payload }) }) };
  deliverTyping(io, { userIds: ["me"], conversationId: "c", userId: "me", typing: true });
  deliverTyping(io, { userIds: [], conversationId: "c", userId: "me", typing: true });
  deliverTyping(io, {});
  assert.deepStrictEqual(emitted, [], "the typer alone, or nobody: nothing at all");
  deliverTyping(io, { userIds: ["me", "you", "you"], conversationId: "c", userId: "me", typing: "yes" });
  assert.deepStrictEqual(emitted, [
    { rooms: ["you"], event: "CONVERSATION_LISTENING", payload: { type: "TYPING", response: { conversationId: "c", userId: "me", typing: false } } },
  ]);
});

// ---------------------------------------------------------------- TYPING

/** A server with a clock the test moves, and a record of anything that would write. */
const typingServer = async ({ mode = "permissive", membersOf } = {}) => {
  const clock = { now: 1_000_000 };
  const writes = [];
  const server = await harness.startServer({
    mode,
    deps: {
      now: () => clock.now,
      findReactionTarget: async () => assert.fail("TYPING reads no message"),
      writeReaction: async (...args) => {
        writes.push(args);
        assert.fail("TYPING writes nothing");
      },
      ...(membersOf ? { membersOf } : {}),
    },
  });
  return { server, clock, writes };
};

test("TYPING reaches the other participants only", async (t) => {
  const { server, clock, writes } = await typingServer();
  const [me, peer, stranger] = [oid(), oid(), oid()];
  const conversationId = oid();
  server.setMembers(conversationId, [me, peer]);
  const mine = await server.userClient(me);
  const myOtherDevice = await server.userClient(me);
  const peers = await server.userClient(peer);
  const strangers = await server.userClient(stranger);
  const heard = { mine: collect(mine, "CONVERSATION_LISTENING"), other: collect(myOtherDevice, "CONVERSATION_LISTENING"), peer: collect(peers, "CONVERSATION_LISTENING"), stranger: collect(strangers, "CONVERSATION_LISTENING") };

  await t.test("published with the others as userIds, delivered to them", async () => {
    mine.emit("TYPING", { conversationId, typing: true });
    await until(() => heard.peer.length === 1);
    assert.deepStrictEqual(server.published("TYPING"), [{ userIds: [peer], conversationId, userId: me, typing: true }]);
    assert.deepStrictEqual(heard.peer[0], { type: "TYPING", response: { conversationId, userId: me, typing: true } });
    await settle();
    assert.deepStrictEqual(heard.mine, [], "never the typer");
    assert.deepStrictEqual(heard.other, [], "nor the typer's other devices");
    assert.deepStrictEqual(heard.stranger, []);
  });

  await t.test("typing:false the same way", async () => {
    clock.now += 50;
    mine.emit("TYPING", { conversationId, typing: false });
    await until(() => heard.peer.length === 2);
    assert.deepStrictEqual(heard.peer[1].response, { conversationId, userId: me, typing: false });
  });

  await t.test("nothing is written: no message, no reaction, no conversation", () => {
    assert.deepStrictEqual(writes, []);
    assert.deepStrictEqual(server.calls.private, []);
    assert.deepStrictEqual(server.calls.group, []);
    assert.deepStrictEqual([...new Set(server.calls.published.map((p) => p.channel))].sort(), ["SETUP", "TYPING"]);
  });

  await server.close();
});

test("TYPING checks membership once per socket and keeps it for 10 minutes", async (t) => {
  const { server, clock } = await typingServer();
  const [me, peer] = [oid(), oid()];
  const conversationId = oid();
  server.setMembers(conversationId, [me, peer]);
  const client = await server.userClient(me);
  const lookups = () => server.calls.lookups.filter((l) => l.conversationId === conversationId && l.userId === me).length;
  const send = async (typing) => {
    const count = server.published("TYPING").length;
    clock.now += 1_000;
    client.emit("TYPING", { conversationId, typing });
    await until(() => server.published("TYPING").length === count + 1);
  };

  await t.test("five events, one lookup", async () => {
    for (const typing of [true, false, true, false, true]) await send(typing);
    assert.strictEqual(lookups(), 1);
  });

  await t.test("the cache carries the other participants: a change within 10 minutes is not seen", async () => {
    const newcomer = oid();
    server.setMembers(conversationId, [me, peer, newcomer]);
    await send(false);
    assert.deepStrictEqual(server.published("TYPING").at(-1).userIds, [peer]);
    assert.strictEqual(lookups(), 1);
  });

  await t.test("after 10 minutes it is looked up again, with the new participants", async () => {
    clock.now += TYPING_RULES.memberTtlMs;
    await send(true);
    assert.strictEqual(lookups(), 2);
    assert.deepStrictEqual(server.published("TYPING").at(-1).userIds.length, 2);
  });

  await t.test("another socket of the same user has its own cache", async () => {
    const second = await server.userClient(me);
    clock.now += 1_000;
    second.emit("TYPING", { conversationId, typing: true });
    await until(() => lookups() === 3);
  });

  await t.test("events that arrive during the first lookup wait for it: one lookup, in order", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const slow = await typingServer({
      membersOf: async (id, userId) => {
        slow.lookups += 1;
        await gate;
        return [{ userId, isMuted: false }, { userId: peer, isMuted: false }];
      },
    });
    slow.lookups = 0;
    const c = await slow.server.userClient(me);
    const id = oid();
    c.emit("TYPING", { conversationId: id, typing: true });
    c.emit("TYPING", { conversationId: id, typing: false });
    await settle(30);
    release();
    await until(() => slow.server.published("TYPING").length === 2);
    assert.strictEqual(slow.lookups, 1);
    assert.deepStrictEqual(slow.server.published("TYPING").map((m) => m.typing), [true, false]);
    await slow.server.close();
  });

  await server.close();
});

test("TYPING is throttled to one a second per conversation, silently", async (t) => {
  const { server, clock } = await typingServer();
  const [me, peer] = [oid(), oid()];
  const [first, second] = [oid(), oid()];
  server.setMembers(first, [me, peer]);
  server.setMembers(second, [me, peer]);
  const client = await server.userClient(me);
  const errors = collect(client, "ERROR");
  const typingIn = (conversationId) => server.published("TYPING").filter((m) => m.conversationId === conversationId).map((m) => m.typing);
  const emit = async (conversationId, typing, advance = 0) => {
    clock.now += advance;
    client.emit("TYPING", { conversationId, typing });
    await settle(25);
  };

  await t.test("a second true within the second is dropped, one a second later goes", async () => {
    await emit(first, true);
    await emit(first, true, 300);
    await emit(first, true, 300);
    assert.deepStrictEqual(typingIn(first), [true]);
    await emit(first, true, 400);
    assert.deepStrictEqual(typingIn(first), [true, true]);
  });

  await t.test("typing:false after a forwarded true goes at once", async () => {
    await emit(first, false, 10);
    assert.deepStrictEqual(typingIn(first), [true, true, false]);
  });

  await t.test("but a repeated false within the second is dropped", async () => {
    await emit(first, false, 10);
    assert.deepStrictEqual(typingIn(first), [true, true, false]);
  });

  await t.test("each conversation has its own second", async () => {
    await emit(second, true, 10);
    assert.deepStrictEqual(typingIn(second), [true]);
  });

  await t.test("dropping is silent: no ERROR", () => {
    assert.deepStrictEqual(errors, []);
  });

  await server.close();
});

test("TYPING refusals", async (t) => {
  const { server, clock } = await typingServer();
  const [me, peer] = [oid(), oid()];
  const conversationId = oid();
  server.setMembers(conversationId, [peer, oid()]);
  const client = await server.userClient(me);

  await t.test("not a participant: NOT_PARTICIPANT, nothing published", async () => {
    const error = nextEvent(client, "ERROR");
    client.emit("TYPING", { conversationId, typing: true });
    assert.deepStrictEqual(
      { code: (await error).code, event: (await error).event, conversationId: (await error).conversationId },
      { code: "NOT_PARTICIPANT", event: "TYPING", conversationId }
    );
    await settle(20);
    assert.deepStrictEqual(server.published("TYPING"), []);
  });

  await t.test("the refusal is remembered for a minute, then looked up again", async () => {
    const lookups = () => server.calls.lookups.filter((l) => l.conversationId === conversationId).length;
    assert.strictEqual(lookups(), 1);
    clock.now += 30_000;
    const again = nextEvent(client, "ERROR");
    client.emit("TYPING", { conversationId, typing: true });
    assert.strictEqual((await again).code, "NOT_PARTICIPANT");
    assert.strictEqual(lookups(), 1);
    clock.now += 30_000;
    const later = nextEvent(client, "ERROR");
    client.emit("TYPING", { conversationId, typing: true });
    await later;
    assert.strictEqual(lookups(), 2);
  });

  for (const [label, payload] of [
    ["a conversationId that is not an ObjectId", { conversationId: "nope", typing: true }],
    ["no conversationId", { typing: true }],
    ["typing not a boolean", { conversationId, typing: "yes" }],
    ["no typing", { conversationId }],
    ["not an object", "typing"],
  ]) {
    await t.test(`${label}: INVALID_PAYLOAD`, async () => {
      const error = nextEvent(client, "ERROR");
      client.emit("TYPING", payload);
      assert.deepStrictEqual({ code: (await error).code, event: (await error).event }, { code: "INVALID_PAYLOAD", event: "TYPING" });
    });
  }

  for (const mode of ["permissive", "enforce"]) {
    await t.test(`a legacy socket in ${mode} mode: AUTH_REQUIRED`, async () => {
      const { server: other } = await typingServer({ mode });
      const id = oid();
      other.setMembers(id, [oid(), oid()]);
      const legacy = await connected(other.client(undefined));
      const error = nextEvent(legacy, "ERROR");
      legacy.emit("TYPING", { conversationId: id, typing: true, userId: oid() });
      assert.strictEqual((await error).code, "AUTH_REQUIRED");
      await settle(20);
      assert.deepStrictEqual(other.published("TYPING"), []);
      assert.strictEqual(logged("legacy_socket", { event: "TYPING", socketId: legacy.id, action: "refused" }).length, 1);
      await other.close();
    });
  }

  await t.test("a membership lookup that fails drops the event quietly, and the next one tries again", async () => {
    let fail = true;
    const flaky = await typingServer({
      membersOf: async (id, userId) => {
        if (fail) throw new Error("mongo down");
        return [{ userId, isMuted: false }, { userId: peer, isMuted: false }];
      },
    });
    const c = await flaky.server.userClient(me);
    const errors = collect(c, "ERROR");
    const id = oid();
    const quiet = console.error;
    console.error = () => {};
    try {
      c.emit("TYPING", { conversationId: id, typing: true });
      await settle(40);
    } finally {
      console.error = quiet;
    }
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(flaky.server.published("TYPING"), []);
    fail = false;
    flaky.clock.now += 1_000;
    c.emit("TYPING", { conversationId: id, typing: true });
    await until(() => flaky.server.published("TYPING").length === 1);
    await flaky.server.close();
  });

  await server.close();
});

test("disconnect: typing:false wherever the socket was still typing", async (t) => {
  const { server, clock } = await typingServer();
  const [me, peer] = [oid(), oid()];
  const [typingHere, typingThere, stopped, alone] = [oid(), oid(), oid(), oid()];
  for (const id of [typingHere, typingThere, stopped]) server.setMembers(id, [me, peer]);
  server.setMembers(alone, [me]);
  const client = await server.userClient(me);
  const peers = await server.userClient(peer);
  const heard = collect(peers, "CONVERSATION_LISTENING");

  for (const [id, typing] of [[typingHere, true], [typingThere, true], [stopped, true], [stopped, false], [alone, true]]) {
    clock.now += 10;
    client.emit("TYPING", { conversationId: id, typing });
  }
  await until(() => heard.length === 4);

  await t.test("one false per conversation last reported true, to the others", async () => {
    const before = server.published("TYPING").length;
    client.disconnect();
    await until(() => server.published("TYPING").length === before + 2);
    const sent = server.published("TYPING").slice(before);
    assert.deepStrictEqual(
      sent.sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
      [typingHere, typingThere].sort().map((conversationId) => ({ userIds: [peer], conversationId, userId: me, typing: false }))
    );
    await until(() => heard.length === 6);
    assert.deepStrictEqual(heard.slice(4).map((e) => [e.type, e.response.typing]), [["TYPING", false], ["TYPING", false]]);
  });

  await t.test("a socket that never typed publishes no TYPING on disconnect", async () => {
    const quiet = await server.userClient(oid());
    const before = server.published("TYPING").length;
    quiet.disconnect();
    await settle(60);
    assert.strictEqual(server.published("TYPING").length, before);
  });

  await t.test("USER_OFFLINE still goes out as before", () => {
    assert.ok(server.published("USER_OFFLINE").some((m) => m.userId === me));
  });

  await server.close();
});

test("a verified socket with no SETUP can type, and its disconnect still clears it", async () => {
  const { server } = await typingServer();
  const [me, peer] = [oid(), oid()];
  const conversationId = oid();
  server.setMembers(conversationId, [me, peer]);
  const client = await connected(server.client({ token: tokenFor(me) }));
  client.emit("TYPING", { conversationId, typing: true });
  await until(() => server.published("TYPING").length === 1);
  client.disconnect();
  await until(() => server.published("TYPING").length === 2);
  assert.strictEqual(server.published("TYPING")[1].typing, false);
  assert.ok(!server.published("USER_OFFLINE").some((m) => m.userId === me), "no SETUP, no USER_OFFLINE, as before");
  await server.close();
});
