/**
 * Company ↔ candidate chat on the sockets (worktrees/ORG-CHAT-CONTRACT.md
 * §3.4), on a real socket.io server with Redis and Mongo replaced
 * (tests/helpers/socket-harness.js, tests/helpers/org-chat-fakes.js):
 *
 * - SETUP joins a member's verified socket to `org:{orgId}` for each
 *   organization they may LIST; never a legacy socket.
 * - NEW_MESSAGE in a company conversation reaches the candidate's room and the
 *   org room; READ_MESSAGE and TYPING follow the same rooms.
 * - NEW_MESSAGE from the candidate into a blocked conversation is refused
 *   with ERROR ORG_CHAT_BLOCKED and nothing is published or pushed.
 */
const { published, cached, stub, query } = require("./helpers/offline");
const { installBackend, installStore, oid } = require("./helpers/org-chat-fakes");
const { collect, connected, nextEvent, settle, startServer, tokenFor, until } = require("./helpers/socket-harness");

const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");

const rooms = require("../dist/socket/rooms.js");
const { env } = require("../dist/config/env.js");
const { orgRoomsFor } = require("../dist/services/org-chat.js");
const { audienceOf } = require("../dist/utils/conversation-access.js");
const { sendPrivateMessage } = require("../dist/controllers/message/index.js");

const ORG = oid();
const OTHER_ORG = oid();
const MEMBER = oid();
const CANDIDATE = oid();
const STRANGER = oid();
const ORG_ROOM = `org:${ORG}`;

const withFlag = (value = "true") => [
  stub(env, "ORG_CHAT_ENABLED", value),
  stub(env, "BACKEND_URL", "https://api.test"),
  stub(env, "CHAT_INTERNAL_KEY", "test-key"),
];
const undo = (restores) => restores.reverse().forEach((restore) => restore());

// ---------------------------------------------------------------- rooms

test("orgRoomOf", () => {
  assert.strictEqual(rooms.orgRoomOf(ORG.toUpperCase()), ORG_ROOM);
  assert.strictEqual(rooms.orgRoomOf(new mongoose.Types.ObjectId(ORG)), ORG_ROOM);
  for (const bad of [undefined, null, "", "org", "nope", 42]) assert.strictEqual(rooms.orgRoomOf(bad), null);
});

test("SETUP: a member's verified socket joins its organizations' rooms", async (t) => {
  const server = await startServer({ deps: { orgRoomsFor: async (userId) => (userId === MEMBER ? [ORG_ROOM, "org:not-a-room", "lobby"] : []) } });
  t.after(() => server.close());

  await t.test("the rooms orgRoomsFor names, valid ones only", async () => {
    const member = await server.userClient(MEMBER);
    await until(() => server.serverSocket(member).rooms.has(ORG_ROOM));
    const joined = [...server.serverSocket(member).rooms];
    assert.ok(joined.includes(MEMBER));
    assert.ok(!joined.includes("org:not-a-room") && !joined.includes("lobby"));
    assert.deepStrictEqual(server.published("SETUP").at(-1).orgRooms, [ORG_ROOM, "org:not-a-room", "lobby"]);
  });

  await t.test("a user who is nobody's member joins none", async () => {
    const candidate = await server.userClient(CANDIDATE);
    assert.ok(![...server.serverSocket(candidate).rooms].some((room) => room.startsWith("org:")));
    assert.strictEqual(server.published("SETUP").at(-1).orgRooms, undefined);
  });

  await t.test("a legacy socket claiming the member's id joins no org room", async () => {
    const legacy = await connected(server.client(undefined));
    legacy.emit("SETUP", { userId: MEMBER });
    await until(() => server.serverSocket(legacy)?.rooms.has(MEMBER));
    assert.ok(!server.serverSocket(legacy).rooms.has(ORG_ROOM));
  });

  await t.test("a SETUP message naming org rooms does not get a legacy socket into them", async () => {
    const legacy = await connected(server.client(undefined));
    rooms.joinSetupRooms(server.io, { userId: MEMBER, socketId: legacy.id, orgRooms: [ORG_ROOM] });
    await settle(20);
    assert.ok(!server.serverSocket(legacy).rooms.has(ORG_ROOM));
  });
});

test("orgRoomsFor: ACTIVE memberships (cached 60 s), each authorized LIST (cached)", async (t) => {
  await t.test("joins only the organizations the backend lets them LIST", async () => {
    cached.clear();
    const restores = withFlag();
    const backend = installBackend({ authorize: (body) => ({ allow: body.organizationId === ORG, organization: null }) });
    let lookups = 0;
    restores.push(
      stub(mongoose.models.OrganizationMember, "find", (filter) => {
        lookups++;
        assert.strictEqual(String(filter.userId), MEMBER);
        assert.strictEqual(filter.status, "ACTIVE");
        return query([{ organizationId: new mongoose.Types.ObjectId(ORG) }, { organizationId: new mongoose.Types.ObjectId(OTHER_ORG) }]);
      })
    );
    try {
      assert.deepStrictEqual(await orgRoomsFor(MEMBER), [ORG_ROOM]);
      assert.deepStrictEqual(await orgRoomsFor(MEMBER), [ORG_ROOM]);
      assert.strictEqual(lookups, 1, "memberships cached");
      assert.strictEqual(backend.authorizations().length, 2, "one LIST per organization, then the cache");
      assert.deepStrictEqual(cached.get(`orgchat:orgs:${MEMBER}`), { value: JSON.stringify([ORG, OTHER_ORG]), ttlSeconds: 60 });
    } finally {
      backend.restore();
      undo(restores);
    }
  });

  await t.test("none with the switch off, and none when the backend is down", async () => {
    cached.clear();
    const off = withFlag("false");
    try {
      assert.deepStrictEqual(await orgRoomsFor(MEMBER), []);
    } finally {
      undo(off);
    }

    cached.clear();
    const restores = withFlag();
    const backend = installBackend({
      authorize: () => {
        throw new Error("down");
      },
    });
    restores.push(stub(mongoose.models.OrganizationMember, "find", () => query([{ organizationId: ORG }])));
    try {
      assert.deepStrictEqual(await orgRoomsFor(MEMBER), []);
    } finally {
      backend.restore();
      undo(restores);
    }
  });
});

test("NEW_MESSAGE in a company conversation: the candidate's room and the org room", async (t) => {
  const server = await startServer({ deps: { orgRoomsFor: async (userId) => (userId === MEMBER ? [ORG_ROOM] : []) } });
  t.after(() => server.close());
  const member = await server.userClient(MEMBER);
  await until(() => server.serverSocket(member).rooms.has(ORG_ROOM));
  const candidate = await server.userClient(CANDIDATE);
  const stranger = await server.userClient(STRANGER);
  const got = { member: collect(member, "CONVERSATION_LISTENING"), candidate: collect(candidate, "CONVERSATION_LISTENING"), stranger: collect(stranger, "CONVERSATION_LISTENING") };
  const now = (fn) => fn();

  await t.test("a company message and a candidate message both reach both sides, nobody else", async () => {
    const conversation = { _id: oid(), organizationId: ORG, participants: [{ user: CANDIDATE }] };
    rooms.deliverNewMessage(server.io, conversation, { _id: oid(), sender: MEMBER, sendAsOrganizationId: ORG, messageType: "TEXT", content: "hi" }, now);
    rooms.deliverNewMessage(server.io, conversation, { _id: oid(), sender: CANDIDATE, messageType: "TEXT", content: "hello" }, now);
    await until(() => got.member.length === 2 && got.candidate.length === 2);
    await settle(30);
    assert.deepStrictEqual(got.member.map((e) => [e.type, e.response.content]), [["NEW_MESSAGE", "hi"], ["NEW_MESSAGE", "hello"]]);
    assert.deepStrictEqual(got.candidate.map((e) => [e.type, e.response.content]), [["NEW_MESSAGE", "hi"], ["NEW_MESSAGE", "hello"]]);
    assert.deepStrictEqual(got.stranger, []);
  });

  await t.test("any other conversation: the participants only, as before", async () => {
    got.member.length = 0;
    got.candidate.length = 0;
    rooms.deliverNewMessage(server.io, { _id: oid(), participants: [{ user: CANDIDATE }, { user: STRANGER }] }, { messageType: "TEXT", content: "dm" }, now);
    await until(() => got.candidate.length === 1 && got.stranger.length === 1);
    await settle(30);
    assert.deepStrictEqual(got.member, []);
  });

  await t.test("a file waits 4 s, the same in the org room", () => {
    const delays = [];
    rooms.deliverNewMessage(server.io, { _id: oid(), organizationId: ORG, participants: [{ user: CANDIDATE }] }, { messageType: "FILE" }, (_fn, ms) => delays.push(ms));
    assert.deepStrictEqual(delays, [4000, 4000]);
  });

  await t.test("READ_MESSAGE with an orgRoom reaches the company; without one, only the named users", async () => {
    got.member.length = 0;
    got.candidate.length = 0;
    rooms.deliverReadMessage(server.io, { userIds: [CANDIDATE], conversationId: "c1", readerId: CANDIDATE, readAt: "t", readAllAt: "t", orgRoom: ORG_ROOM });
    await until(() => got.member.length === 1 && got.candidate.length === 1);
    assert.deepStrictEqual(got.member[0], { type: "READ_MESSAGE", response: "c1", readerId: CANDIDATE, readAt: "t", readAllAt: "t" });

    got.member.length = 0;
    rooms.deliverReadMessage(server.io, { userIds: [CANDIDATE], conversationId: "c1", readerId: MEMBER, readAt: "t", readAllAt: "t", orgRoom: "lobby" });
    await settle(40);
    assert.deepStrictEqual(got.member, [], "only a real org room");
  });
});

test("TYPING between the candidate and the company", async (t) => {
  const conversationId = oid();
  /** audienceOf as utils/conversation-access.ts answers it, over one company conversation. */
  const audience = async (id, userId, orgRooms) => {
    if (id !== conversationId) return null;
    if (userId === CANDIDATE) return { participant: true, others: [], orgRoom: ORG_ROOM };
    if (orgRooms.includes(ORG_ROOM)) return { participant: false, others: [CANDIDATE], orgRoom: null };
    return null;
  };
  const server = await startServer({
    mode: "enforce",
    deps: {
      orgRoomsFor: async (userId) => (userId === MEMBER ? [ORG_ROOM] : []),
      audienceOf: audience,
      publish: (channel, message) => {
        const parsed = JSON.parse(message);
        server.calls.published.push({ channel, message: parsed });
        if (channel === "SETUP") rooms.joinSetupRooms(server.io, parsed);
        if (channel === "TYPING") rooms.deliverTyping(server.io, parsed);
      },
    },
  });
  t.after(() => server.close());
  const member = await server.userClient(MEMBER);
  await until(() => server.serverSocket(member).rooms.has(ORG_ROOM));
  const candidate = await server.userClient(CANDIDATE);
  const stranger = await server.userClient(STRANGER);

  await t.test("the candidate typing is heard in the org room", async () => {
    const heard = nextEvent(member, "CONVERSATION_LISTENING");
    candidate.emit("TYPING", { conversationId, typing: true });
    assert.deepStrictEqual(await heard, { type: "TYPING", response: { conversationId, userId: CANDIDATE, typing: true } });
    assert.strictEqual(server.published("TYPING").at(-1).orgRoom, ORG_ROOM);
  });

  await t.test("a member typing for the company is heard by the candidate", async () => {
    const heard = nextEvent(candidate, "CONVERSATION_LISTENING");
    member.emit("TYPING", { conversationId, typing: true });
    assert.deepStrictEqual(await heard, { type: "TYPING", response: { conversationId, userId: MEMBER, typing: true } });
  });

  await t.test("someone outside both is NOT_PARTICIPANT; a member is not a participant for DELIVERED", async () => {
    const refused = nextEvent(stranger, "ERROR");
    stranger.emit("TYPING", { conversationId, typing: true });
    assert.strictEqual((await refused).code, "NOT_PARTICIPANT");

    const delivered = nextEvent(member, "ERROR");
    member.emit("DELIVERED", { conversationId });
    assert.strictEqual((await delivered).code, "NOT_PARTICIPANT");
  });

  await t.test("the candidate disconnecting stops their dots in the org room", async () => {
    const heard = collect(member, "CONVERSATION_LISTENING");
    candidate.disconnect();
    await until(() => heard.some((event) => event.type === "TYPING" && event.response.typing === false));
  });
});

test("audienceOf: participants, plus the org room of a company conversation", async (t) => {
  const conversation = { _id: oid(), organizationId: ORG, participants: [{ user: CANDIDATE }], latestMessageData: {} };
  const dm = { _id: oid(), participants: [{ user: CANDIDATE }, { user: STRANGER }], latestMessageData: {} };
  const store = installStore({ conversations: [conversation, dm] });
  const restores = [stub(env, "ORG_CHAT_ENABLED", "true")];
  t.after(() => {
    undo(restores);
    store.restore();
  });

  await t.test("the candidate: a participant, heard by the org room", async () => {
    assert.deepStrictEqual(await audienceOf(conversation._id, CANDIDATE, []), { participant: true, others: [], orgRoom: ORG_ROOM });
  });
  await t.test("a member in the org room: heard by the candidate", async () => {
    assert.deepStrictEqual(await audienceOf(conversation._id, MEMBER, [ORG_ROOM]), { participant: false, others: [CANDIDATE], orgRoom: null });
  });
  await t.test("a member of another organization, or no rooms at all: nobody", async () => {
    assert.strictEqual(await audienceOf(conversation._id, MEMBER, [`org:${OTHER_ORG}`]), null);
    assert.strictEqual(await audienceOf(conversation._id, MEMBER, []), null);
  });
  await t.test("a private conversation: exactly membersOf", async () => {
    assert.deepStrictEqual(await audienceOf(dm._id, CANDIDATE, [ORG_ROOM]), { participant: true, others: [STRANGER], orgRoom: null });
  });
  await t.test("switched off: no org room either way", async () => {
    const off = stub(env, "ORG_CHAT_ENABLED", "false");
    try {
      assert.deepStrictEqual(await audienceOf(conversation._id, CANDIDATE, []), { participant: true, others: [], orgRoom: null });
      assert.strictEqual(await audienceOf(conversation._id, MEMBER, [ORG_ROOM]), null);
    } finally {
      off();
    }
  });
});

test("NEW_MESSAGE from the candidate into a blocked company conversation: ERROR ORG_CHAT_BLOCKED, nothing kept", async () => {
  published.length = 0;
  const conversation = { _id: oid(), organizationId: ORG, candidateUserId: CANDIDATE, candidateBlockedAt: new Date(), participants: [{ user: CANDIDATE }], latestMessageData: {} };
  const store = installStore({ conversations: [conversation] });
  let aborted = 0;
  let committed = 0;
  const session = {
    startTransaction() {},
    inTransaction: () => true,
    async commitTransaction() {
      committed++;
    },
    async abortTransaction() {
      aborted++;
    },
    endSession() {},
  };
  const restores = [...withFlag(), stub(mongoose, "startSession", async () => session)];
  const backend = installBackend({ authorize: () => ({ allow: true, organization: null }) });
  try {
    const emitted = [];
    const socket = { id: "s1", emit: (event, payload) => emitted.push({ event, payload }) };
    await sendPrivateMessage(socket, {}, { messageType: "TEXT", content: "bye", senderId: CANDIDATE, receiverId: CANDIDATE, conversationId: conversation._id, _id: oid() });
    await settle(20);

    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].event, "ERROR");
    assert.strictEqual(emitted[0].payload.code, "ORG_CHAT_BLOCKED");
    assert.strictEqual(emitted[0].payload.event, "NEW_MESSAGE");
    assert.strictEqual(emitted[0].payload.conversationId, conversation._id);
    assert.strictEqual(aborted, 1, "the transaction is aborted: Mongo keeps neither the message nor the latest-message update");
    assert.strictEqual(committed, 0);
    assert.deepStrictEqual(published.filter((p) => p.channel === "SEND_MESSAGE"), []);
    assert.deepStrictEqual(backend.pushes(), []);
  } finally {
    backend.restore();
    undo(restores);
    store.restore();
  }
});

test("a candidate's NEW_MESSAGE in an open company conversation is pushed to the company (ORGANIZATION)", async () => {
  published.length = 0;
  const conversation = { _id: oid(), conversationType: "PRIVATE", organizationId: ORG, candidateUserId: CANDIDATE, participants: [{ user: CANDIDATE, isMuted: false }], latestMessageData: {} };
  const store = installStore({ conversations: [conversation] });
  const session = { startTransaction() {}, inTransaction: () => true, async commitTransaction() {}, async abortTransaction() {}, endSession() {} };
  const restores = [...withFlag(), stub(mongoose, "startSession", async () => session)];
  const backend = installBackend({ authorize: () => ({ allow: true, organization: null }) });
  try {
    const emitted = [];
    await sendPrivateMessage({ id: "s1", emit: (event, payload) => emitted.push({ event, payload }) }, {}, {
      messageType: "TEXT",
      content: "Thank you",
      senderId: CANDIDATE,
      receiverId: CANDIDATE,
      conversationId: conversation._id,
    });
    await settle(20);
    assert.deepStrictEqual(emitted, []);
    const [notice] = published.filter((p) => p.channel === "SEND_MESSAGE").map((p) => p.message);
    assert.strictEqual(String(notice.conversation.organizationId), ORG);
    const [push] = backend.pushes();
    assert.strictEqual(push.audience, "ORGANIZATION");
    assert.strictEqual(push.organizationId, ORG);
    assert.deepStrictEqual(push.recipientIds, []);
  } finally {
    backend.restore();
    undo(restores);
    store.restore();
  }
});
