/**
 * The socket layer, end to end over a real socket.io server and client.
 *
 * Redis and Mongo are replaced through SocketDeps: `publish` records what
 * would go on Redis and, for SETUP, does what the Redis subscriber does with
 * it (joinSetupRooms); membership and partners come from in-memory maps; the
 * message controllers are stubs that record what they were asked to store.
 * Runs against dist/: npm test
 */
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { Server } = require("socket.io");
const { io: connect } = require("socket.io-client");
const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || "test-secret";
const SECRET = process.env.JWT_SECRET_KEY;

const { registerSocketHandlers } = require("../dist/socket/handlers.js");
const { joinSetupRooms, emitPresence, routePayment, deliverPayment } = require("../dist/socket/rooms.js");

const oid = () => new Types.ObjectId().toString();
const tokenFor = (userId, options = { expiresIn: "1h" }) => jwt.sign({ userId }, SECRET, options);

/** STICKER_URL_PREFIX's default, which the harness passes as SocketDeps.stickerUrlPrefix. */
const STICKER_PREFIX = "https://seemuehub-storage.s3.ap-southeast-1.amazonaws.com/images/";

// ---------------------------------------------------------------- harness

/** Collects the JSON log lines (legacy_socket, sender_override, ...) while a test runs. */
const logs = [];
const originalLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("{")) {
    try {
      logs.push(JSON.parse(args[0]));
      return;
    } catch {}
  }
  originalLog(...args);
};
const logged = (msg, match = {}) =>
  logs.filter((line) => line.msg === msg && Object.entries(match).every(([k, v]) => line[k] === v));

const until = async (predicate, ms = 1000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

const nextEvent = (client, event, ms = 1000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} within ${ms}ms`)), ms);
    client.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });

const noEvent = (client, event, ms = 120) =>
  new Promise((resolve, reject) => {
    const handler = (data) => reject(new Error(`unexpected ${event}: ${JSON.stringify(data)}`));
    client.on(event, handler);
    setTimeout(() => {
      client.off(event, handler);
      resolve();
    }, ms);
  });

const connected = (client) =>
  new Promise((resolve, reject) => {
    client.once("connect", () => resolve(client));
    client.once("connect_error", (err) => reject(err));
  });

const refused = (client) =>
  new Promise((resolve, reject) => {
    client.once("connect", () => reject(new Error("connected, expected connect_error")));
    client.once("connect_error", (err) => resolve(err));
  });

async function startServer(mode, { partners = {} } = {}) {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  const calls = { published: [], private: [], group: [] };
  /** conversationId -> Set of member userIds */
  const members = new Map();

  registerSocketHandlers(io, {
    mode,
    publish: (channel, message) => {
      const parsed = JSON.parse(message);
      calls.published.push({ channel, message: parsed });
      if (channel === "SETUP") joinSetupRooms(io, parsed);
    },
    isParticipant: async (conversationId, userId) => members.get(conversationId)?.has(userId) ?? false,
    conversationPartners: async (userId) => partners[userId] ?? [],
    sendPrivateMessage: async (_socket, _io, data) => {
      calls.private.push(data);
    },
    sendGroupMessage: async (_socket, _io, data) => {
      calls.group.push(data);
    },
    stickerUrlPrefix: STICKER_PREFIX,
  });

  await new Promise((r) => httpServer.listen(0, r));
  const url = `http://localhost:${httpServer.address().port}`;
  const clients = [];

  return {
    io,
    calls,
    members,
    /** A client; `auth` undefined means a legacy client that sends none. */
    client(auth) {
      const client = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false, auth });
      clients.push(client);
      return client;
    },
    serverSocket: (client) => io.sockets.sockets.get(client.id),
    published: (channel) => calls.published.filter((p) => p.channel === channel).map((p) => p.message),
    async close() {
      for (const client of clients) client.disconnect();
      io.close();
      await settle(20);
    },
  };
}

const textMessage = (extra = {}) => ({ messageType: "TEXT", content: "hello", ...extra });
/** A sticker as the contract has clients send it. */
const stickerMessage = (extra = {}) => ({
  messageType: "STICKER",
  content: "STICKER",
  attachments: [{ fileName: oid(), fileUrl: `${STICKER_PREFIX}stickers/${oid()}.webp` }],
  ...extra,
});

// ---------------------------------------------------------------- handshake

test("handshake", async (t) => {
  const server = await startServer("permissive");
  const userId = oid();

  await t.test("a valid token connects and becomes socket.data.userId", async () => {
    const client = await connected(server.client({ token: tokenFor(userId) }));
    assert.strictEqual(server.serverSocket(client).data.userId, userId);
  });

  await t.test("the Bearer form is accepted", async () => {
    const client = await connected(server.client({ token: `Bearer ${tokenFor(userId)}` }));
    assert.strictEqual(server.serverSocket(client).data.userId, userId);
  });

  await t.test("an expired token is refused with TOKEN_EXPIRED (message and data.code)", async () => {
    const expired = jwt.sign({ userId, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
    const err = await refused(server.client({ token: expired }));
    assert.strictEqual(err.message, "TOKEN_EXPIRED");
    assert.deepStrictEqual(err.data, { code: "TOKEN_EXPIRED" });
  });

  await t.test("an invalid token is refused with TOKEN_INVALID", async () => {
    const err = await refused(server.client({ token: "not.a.jwt" }));
    assert.strictEqual(err.message, "TOKEN_INVALID");
    assert.deepStrictEqual(err.data, { code: "TOKEN_INVALID" });
  });

  await t.test("a token signed with another secret is refused with TOKEN_INVALID", async () => {
    const err = await refused(server.client({ token: jwt.sign({ userId }, "someone-else") }));
    assert.strictEqual(err.message, "TOKEN_INVALID");
  });

  await t.test("a refresh token is refused with TOKEN_INVALID", async () => {
    const err = await refused(server.client({ token: jwt.sign({ userId, type: "refresh" }, SECRET) }));
    assert.strictEqual(err.message, "TOKEN_INVALID");
  });

  await t.test("no token connects as a legacy socket, and is logged", async () => {
    const client = await connected(server.client(undefined));
    assert.strictEqual(server.serverSocket(client).data.userId, undefined);
    await until(() => logged("legacy_socket", { event: "connect", socketId: client.id }).length === 1);
  });

  await t.test("an empty token is the same as none", async () => {
    const client = await connected(server.client({ token: "" }));
    assert.strictEqual(server.serverSocket(client).data.userId, undefined);
  });

  await server.close();
});

// ---------------------------------------------------------------- SETUP

test("SETUP from a verified socket", async (t) => {
  const me = oid();
  const partner = oid();
  const server = await startServer("permissive", { partners: { [me]: [partner] } });

  await t.test("joins the verified user's room, not the one in the payload", async () => {
    const someoneElse = oid();
    const client = await connected(server.client({ token: tokenFor(me) }));
    client.emit("SETUP", { userId: someoneElse });
    await until(() => server.published("SETUP").some((m) => m.socketId === client.id));

    const message = server.published("SETUP").find((m) => m.socketId === client.id);
    assert.strictEqual(message.userId, me, "Redis SETUP must carry the verified user");
    const rooms = server.serverSocket(client).rooms;
    assert.ok(rooms.has(me));
    assert.ok(!rooms.has(someoneElse));
    assert.strictEqual(logged("setup_user_mismatch", { userId: me, claimedUserId: someoneElse }).length, 1);

    // And delivery follows the room.
    const received = nextEvent(client, "LISTENING");
    server.io.to(me).emit("LISTENING", { type: "PAYMENT", response: { ok: true } });
    assert.deepStrictEqual(await received, { type: "PAYMENT", response: { ok: true } });
    const stolen = noEvent(client, "LISTENING");
    server.io.to(someoneElse).emit("LISTENING", { type: "PAYMENT", response: { stolen: true } });
    await stolen;
  });

  await t.test("SETUP with no userId at all still joins the verified room", async () => {
    const client = await connected(server.client({ token: tokenFor(me) }));
    client.emit("SETUP", {});
    await until(() => server.serverSocket(client)?.rooms.has(me));
  });

  await t.test("a conversation room is refused to a non-participant", async () => {
    const conversationId = oid();
    const client = await connected(server.client({ token: tokenFor(me) }));
    const error = nextEvent(client, "ERROR");
    client.emit("SETUP", { userId: me, conversationId });
    assert.deepStrictEqual(
      { code: (await error).code, event: (await error).event, conversationId: (await error).conversationId },
      { code: "NOT_PARTICIPANT", event: "SETUP", conversationId }
    );
    await until(() => server.published("SETUP").some((m) => m.socketId === client.id));
    const message = server.published("SETUP").find((m) => m.socketId === client.id);
    assert.strictEqual(message.conversationId, undefined);
    assert.ok(!server.serverSocket(client).rooms.has(conversationId));
    assert.ok(server.serverSocket(client).rooms.has(me), "the user's own room is still joined");
  });

  await t.test("a conversation room is joined by a participant", async () => {
    const conversationId = oid();
    server.members.set(conversationId, new Set([me, partner]));
    const client = await connected(server.client({ token: tokenFor(me) }));
    client.emit("SETUP", { userId: me, conversationId });
    await until(() => server.serverSocket(client)?.rooms.has(conversationId));
  });

  await t.test("partners are looked up once and published; disconnect publishes USER_OFFLINE to them", async () => {
    const client = await connected(server.client({ token: tokenFor(me) }));
    client.emit("SETUP", {});
    await until(() => server.published("SETUP").some((m) => m.socketId === client.id));
    assert.deepStrictEqual(server.published("SETUP").find((m) => m.socketId === client.id).partners, [partner]);

    const socketId = client.id;
    client.disconnect();
    await until(() => server.published("USER_OFFLINE").some((m) => m.socketId === socketId));
    assert.deepStrictEqual(server.published("USER_OFFLINE").find((m) => m.socketId === socketId), {
      socketId,
      userId: me,
      partners: [partner],
    });
  });

  await t.test("a socket that never set up publishes no USER_OFFLINE", async () => {
    const client = await connected(server.client({ token: tokenFor(me) }));
    const socketId = client.id;
    client.disconnect();
    await settle();
    assert.ok(!server.published("USER_OFFLINE").some((m) => m.socketId === socketId));
  });

  await t.test("a SETUP message naming another user cannot move a verified socket", async () => {
    const client = await connected(server.client({ token: tokenFor(me) }));
    const intruder = oid();
    assert.strictEqual(joinSetupRooms(server.io, { userId: intruder, socketId: client.id }), "refused");
    assert.ok(!server.serverSocket(client).rooms.has(intruder));
  });

  await server.close();
});

// ---------------------------------------------------------------- messages

test("NEW_MESSAGE from a verified socket", async (t) => {
  const me = oid();
  const server = await startServer("permissive");
  const client = await connected(server.client({ token: tokenFor(me) }));

  await t.test("senderId is the verified user whatever the payload says", async () => {
    const impostor = oid();
    const receiverId = oid();
    client.emit("NEW_MESSAGE", textMessage({ senderId: impostor, receiverId }));
    await until(() => server.calls.private.length === 1);
    assert.strictEqual(server.calls.private[0].senderId, me);
    assert.strictEqual(server.calls.private[0].receiverId, receiverId);
    assert.strictEqual(logged("sender_override", { userId: me, claimedSenderId: impostor }).length, 1);
  });

  await t.test("fields that would impersonate an organization or the system are dropped", async () => {
    server.calls.private.length = 0;
    client.emit(
      "NEW_MESSAGE",
      textMessage({
        receiverId: oid(),
        sender: oid(),
        actorUserId: oid(),
        sendAsOrganizationId: oid(),
        isOrderMessage: true,
        orderStatus: "COMPLETED",
        attachments: [{ fileName: "a.png", fileUrl: "https://x/a.png" }],
      })
    );
    await until(() => server.calls.private.length === 1);
    const stored = server.calls.private[0];
    for (const field of ["sender", "actorUserId", "sendAsOrganizationId", "isOrderMessage", "orderStatus"]) {
      assert.ok(!(field in stored), `${field} must not reach the controller`);
    }
    assert.deepStrictEqual(stored.attachments, [{ fileName: "a.png", fileUrl: "https://x/a.png" }]);
  });

  await t.test("into a conversation the sender is not in: ERROR NOT_PARTICIPANT, nothing stored", async () => {
    server.calls.private.length = 0;
    const conversationId = oid();
    const _id = oid();
    const error = nextEvent(client, "ERROR");
    client.emit("NEW_MESSAGE", textMessage({ senderId: me, receiverId: oid(), conversationId, _id }));
    const payload = await error;
    assert.strictEqual(payload.code, "NOT_PARTICIPANT");
    assert.strictEqual(payload.event, "NEW_MESSAGE");
    assert.strictEqual(payload.conversationId, conversationId);
    assert.strictEqual(payload._id, _id, "the client's message id comes back so it can mark it failed");
    await settle();
    assert.strictEqual(server.calls.private.length, 0);
  });

  await t.test("into a conversation the sender is in: stored", async () => {
    const conversationId = oid();
    server.members.set(conversationId, new Set([me]));
    client.emit("NEW_MESSAGE", textMessage({ senderId: me, receiverId: oid(), conversationId }));
    await until(() => server.calls.private.length === 1);
    assert.strictEqual(server.calls.private[0].conversationId, conversationId);
  });

  await t.test("without a conversationId it goes to create-or-get between sender and receiver", async () => {
    server.calls.private.length = 0;
    const receiverId = oid();
    client.emit("NEW_MESSAGE", textMessage({ receiverId }));
    await until(() => server.calls.private.length === 1);
    assert.strictEqual(server.calls.private[0].senderId, me);
    assert.strictEqual(server.calls.private[0].conversationId, undefined);
  });

  await t.test("a non-object payload is refused", async () => {
    const error = nextEvent(client, "ERROR");
    client.emit("NEW_MESSAGE", "hello");
    assert.strictEqual((await error).code, "INVALID_PAYLOAD");
  });

  await server.close();
});

test("NEW_GROUP_MESSAGE from a verified socket", async (t) => {
  const me = oid();
  const server = await startServer("permissive");
  const client = await connected(server.client({ token: tokenFor(me) }));

  await t.test("a non-participant is refused and nothing is stored", async () => {
    const conversationId = oid();
    server.members.set(conversationId, new Set([oid(), oid()]));
    const error = nextEvent(client, "ERROR");
    client.emit("NEW_GROUP_MESSAGE", textMessage({ senderId: me, conversationId }));
    const payload = await error;
    assert.strictEqual(payload.code, "NOT_PARTICIPANT");
    assert.strictEqual(payload.event, "NEW_GROUP_MESSAGE");
    await settle();
    assert.strictEqual(server.calls.group.length, 0);
  });

  await t.test("without a conversationId it is refused", async () => {
    const error = nextEvent(client, "ERROR");
    client.emit("NEW_GROUP_MESSAGE", textMessage({ senderId: me }));
    assert.strictEqual((await error).code, "NOT_PARTICIPANT");
  });

  await t.test("a participant's message is stored with the verified senderId", async () => {
    const conversationId = oid();
    server.members.set(conversationId, new Set([me]));
    client.emit("NEW_GROUP_MESSAGE", textMessage({ senderId: oid(), conversationId }));
    await until(() => server.calls.group.length === 1);
    assert.strictEqual(server.calls.group[0].senderId, me);
  });

  await server.close();
});

test("server-only message types are refused over the socket", async (t) => {
  const me = oid();
  const server = await startServer("permissive");
  const client = await connected(server.client({ token: tokenFor(me) }));
  const conversationId = oid();
  server.members.set(conversationId, new Set([me]));

  // SYSTEM and ORDER_* render as the service's own events ("payment received",
  // "order completed"); a client could post them into any conversation it is in.
  for (const messageType of ["SYSTEM", "ORDER_UPDATE", "ORDER_STATUS_CHANGE", "ORDER_PAYMENT", "ORDER_DELIVERY"]) {
    await t.test(`NEW_MESSAGE ${messageType}: ERROR INVALID_PAYLOAD, nothing stored`, async () => {
      server.calls.private.length = 0;
      const _id = oid();
      const error = nextEvent(client, "ERROR");
      client.emit("NEW_MESSAGE", textMessage({ receiverId: oid(), messageType, _id }));
      const payload = await error;
      assert.deepStrictEqual(
        { code: payload.code, event: payload.event, field: payload.field, _id: payload._id },
        { code: "INVALID_PAYLOAD", event: "NEW_MESSAGE", field: "messageType", _id }
      );
      await settle();
      assert.strictEqual(server.calls.private.length, 0);
      assert.strictEqual(logged("message_refused", { field: "messageType", messageType, userId: me }).length, 1);
    });
  }

  await t.test("NEW_GROUP_MESSAGE SYSTEM into the sender's own conversation: refused too", async () => {
    const error = nextEvent(client, "ERROR");
    client.emit("NEW_GROUP_MESSAGE", textMessage({ conversationId, messageType: "SYSTEM" }));
    assert.strictEqual((await error).code, "INVALID_PAYLOAD");
    await settle();
    assert.strictEqual(server.calls.group.length, 0);
  });

  await t.test("a missing or non-string messageType is refused", async () => {
    for (const messageType of [undefined, 42, ""]) {
      const error = nextEvent(client, "ERROR");
      client.emit("NEW_MESSAGE", { content: "hi", receiverId: oid(), messageType });
      assert.strictEqual((await error).code, "INVALID_PAYLOAD");
    }
    await settle();
    assert.strictEqual(server.calls.private.length, 0);
  });

  await t.test("a legacy socket is held to the same rule", async () => {
    const legacy = await connected(server.client(undefined));
    const error = nextEvent(legacy, "ERROR");
    legacy.emit("NEW_MESSAGE", textMessage({ senderId: oid(), receiverId: oid(), messageType: "ORDER_PAYMENT" }));
    assert.strictEqual((await error).code, "INVALID_PAYLOAD");
    await settle();
    assert.strictEqual(server.calls.private.length, 0);
  });

  await t.test("the client types still go through", async () => {
    server.calls.private.length = 0;
    const types = ["TEXT", "IMAGE", "VIDEO", "VOICE", "FILE", "STICKER", "LOCATION"];
    for (const messageType of types) {
      // A STICKER also needs its sticker (see "STICKER messages over the socket").
      const message = messageType === "STICKER" ? stickerMessage() : textMessage({ messageType });
      client.emit("NEW_MESSAGE", { ...message, receiverId: oid() });
    }
    await until(() => server.calls.private.length === types.length);
    assert.deepStrictEqual(server.calls.private.map((m) => m.messageType).sort(), [...types].sort());
  });

  await server.close();
});

test("STICKER messages over the socket", async (t) => {
  const me = oid();
  const server = await startServer("permissive");
  const client = await connected(server.client({ token: tokenFor(me) }));
  const conversationId = oid();
  server.members.set(conversationId, new Set([me]));

  await t.test("a valid sticker is stored, its content forced to STICKER and its attachment cut to the contract", async () => {
    server.calls.private.length = 0;
    const fileName = oid();
    const fileUrl = `${STICKER_PREFIX}stickers/${fileName}.png`;
    client.emit("NEW_MESSAGE", {
      messageType: "STICKER",
      content: "anything at all",
      receiverId: oid(),
      attachments: [{ fileName, fileUrl, originalName: "<b>hi</b>", fileSize: "9999999" }],
    });
    await until(() => server.calls.private.length === 1);
    const stored = server.calls.private[0];
    assert.strictEqual(stored.messageType, "STICKER");
    assert.strictEqual(stored.content, "STICKER");
    assert.deepStrictEqual(stored.attachments, [{ fileName, fileUrl }]);
  });

  await t.test("a sticker sent without content still goes through (content is the service's to set)", async () => {
    server.calls.private.length = 0;
    const { content, ...withoutContent } = stickerMessage({ receiverId: oid() });
    client.emit("NEW_MESSAGE", withoutContent);
    await until(() => server.calls.private.length === 1);
    assert.strictEqual(server.calls.private[0].content, "STICKER");
  });

  const good = () => ({ fileName: oid(), fileUrl: `${STICKER_PREFIX}${oid()}.webp` });
  const invalid = [
    ["no attachments", undefined, "ATTACHMENT_COUNT"],
    ["an empty attachments array", [], "ATTACHMENT_COUNT"],
    ["two attachments", [good(), good()], "ATTACHMENT_COUNT"],
    ["attachments that are not an array", good(), "ATTACHMENT_COUNT"],
    ["an attachment that is not an object", ["https://x/a.png"], "FILE_URL"],
    ["no fileUrl", [{ fileName: oid() }], "FILE_URL"],
    ["an image from another host", [{ fileName: oid(), fileUrl: "https://example.com/images/a.png" }], "FILE_URL"],
    ["the bucket over plain http", [{ fileName: oid(), fileUrl: STICKER_PREFIX.replace("https:", "http:") + "a.png" }], "FILE_URL"],
    ["the bucket outside images/", [{ fileName: oid(), fileUrl: STICKER_PREFIX.replace("/images/", "/private/") + "a.png" }], "FILE_URL"],
    ["a lookalike host", [{ fileName: oid(), fileUrl: STICKER_PREFIX.replace(".com/", ".com.evil.net/") + "a.png" }], "FILE_URL"],
    ["a ../ out of images/", [{ fileName: oid(), fileUrl: `${STICKER_PREFIX}../private/a.png` }], "FILE_URL"],
    ["an encoded %2e%2e/ out of images/", [{ fileName: oid(), fileUrl: `${STICKER_PREFIX}%2e%2e/private/a.png` }], "FILE_URL"],
    ["a fileName that is not an id", [{ fileName: "smile.png", fileUrl: `${STICKER_PREFIX}a.png` }], "FILE_NAME"],
    ["a 23-hex fileName", [{ fileName: oid().slice(1), fileUrl: `${STICKER_PREFIX}a.png` }], "FILE_NAME"],
    ["no fileName", [{ fileUrl: `${STICKER_PREFIX}a.png` }], "FILE_NAME"],
  ];
  for (const [label, attachments, reason] of invalid) {
    await t.test(`${label}: ERROR INVALID_PAYLOAD (field attachments), nothing stored`, async () => {
      server.calls.private.length = 0;
      const _id = oid();
      const error = nextEvent(client, "ERROR");
      client.emit("NEW_MESSAGE", { messageType: "STICKER", content: "STICKER", receiverId: oid(), attachments, _id });
      const payload = await error;
      assert.deepStrictEqual(
        { code: payload.code, event: payload.event, field: payload.field, _id: payload._id },
        { code: "INVALID_PAYLOAD", event: "NEW_MESSAGE", field: "attachments", _id }
      );
      await settle();
      assert.strictEqual(server.calls.private.length, 0);
      assert.ok(logged("message_refused", { field: "attachments", reason, userId: me }).length >= 1, `logged with reason ${reason}`);
    });
  }

  await t.test("NEW_GROUP_MESSAGE is held to the same rule", async () => {
    const error = nextEvent(client, "ERROR");
    client.emit("NEW_GROUP_MESSAGE", stickerMessage({ conversationId, attachments: [] }));
    assert.strictEqual((await error).field, "attachments");
    await settle();
    assert.strictEqual(server.calls.group.length, 0);

    client.emit("NEW_GROUP_MESSAGE", stickerMessage({ conversationId, content: "hi" }));
    await until(() => server.calls.group.length === 1);
    assert.strictEqual(server.calls.group[0].content, "STICKER");
  });

  await t.test("a legacy socket is held to the same rule", async () => {
    server.calls.private.length = 0;
    const legacy = await connected(server.client(undefined));
    const error = nextEvent(legacy, "ERROR");
    legacy.emit("NEW_MESSAGE", stickerMessage({ senderId: oid(), receiverId: oid(), attachments: [{ fileName: oid(), fileUrl: "https://example.com/a.png" }] }));
    assert.strictEqual((await error).field, "attachments");
    await settle();
    assert.strictEqual(server.calls.private.length, 0);
  });

  await t.test("other types keep their attachments as sent", async () => {
    server.calls.private.length = 0;
    const attachments = [{ fileName: "a.png", fileUrl: "https://example.com/a.png" }, { fileName: "b.png", fileUrl: "https://example.com/b.png" }];
    client.emit("NEW_MESSAGE", textMessage({ receiverId: oid(), messageType: "IMAGE", content: "photos", attachments }));
    await until(() => server.calls.private.length === 1);
    assert.deepStrictEqual(server.calls.private[0].attachments, attachments);
    assert.strictEqual(server.calls.private[0].content, "photos");
  });

  await server.close();
});

test("a verified socket whose token expires mid-connection", async (t) => {
  const me = oid();
  const server = await startServer("permissive");
  const client = await connected(server.client({ token: tokenFor(me) }));
  server.serverSocket(client).data.tokenExpiresAt = Math.floor(Date.now() / 1000) - 1;

  await t.test("sends are refused with TOKEN_EXPIRED", async () => {
    const error = nextEvent(client, "ERROR");
    client.emit("NEW_MESSAGE", textMessage({ receiverId: oid() }));
    const payload = await error;
    assert.strictEqual(payload.code, "TOKEN_EXPIRED");
    assert.strictEqual(payload.event, "NEW_MESSAGE");
    await settle();
    assert.strictEqual(server.calls.private.length, 0);
  });

  await t.test("SETUP too", async () => {
    const error = nextEvent(client, "ERROR");
    client.emit("SETUP", {});
    assert.strictEqual((await error).code, "TOKEN_EXPIRED");
  });

  await server.close();
});

// ---------------------------------------------------------------- modes

test("SOCKET_AUTH_MODE=permissive keeps legacy sockets working, and logs them", async (t) => {
  const server = await startServer("permissive");
  const client = await connected(server.client(undefined));
  const claimed = oid();

  await t.test("legacy SETUP joins the claimed room", async () => {
    client.emit("SETUP", { userId: claimed });
    await until(() => server.serverSocket(client)?.rooms.has(claimed));
    const [line] = logged("legacy_socket", { event: "SETUP", socketId: client.id });
    assert.deepStrictEqual(
      { mode: line.mode, action: line.action, claimedUserId: line.claimedUserId },
      { mode: "permissive", action: "allowed", claimedUserId: claimed }
    );
  });

  await t.test("legacy NEW_MESSAGE is sent with the payload's senderId", async () => {
    client.emit("NEW_MESSAGE", textMessage({ senderId: claimed, receiverId: oid(), sendAsOrganizationId: oid() }));
    await until(() => server.calls.private.length === 1);
    assert.strictEqual(server.calls.private[0].senderId, claimed);
    assert.ok(!("sendAsOrganizationId" in server.calls.private[0]));
    assert.strictEqual(logged("legacy_socket", { event: "NEW_MESSAGE", socketId: client.id }).length, 1);
  });

  await t.test("legacy NEW_GROUP_MESSAGE is sent as before", async () => {
    client.emit("NEW_GROUP_MESSAGE", textMessage({ senderId: claimed, conversationId: oid() }));
    await until(() => server.calls.group.length === 1);
  });

  await t.test("a signed-out page's SETUP (no userId) publishes nothing", async () => {
    const anonymous = await connected(server.client(undefined));
    anonymous.emit("SETUP", { userId: undefined });
    await settle();
    assert.ok(!server.published("SETUP").some((m) => m.socketId === anonymous.id));
  });

  await server.close();
});

test("SOCKET_AUTH_MODE=enforce refuses SETUP and sends from legacy sockets", async (t) => {
  const server = await startServer("enforce");

  await t.test("a legacy socket may still connect", async () => {
    await connected(server.client(undefined));
  });

  for (const event of ["SETUP", "NEW_MESSAGE", "NEW_GROUP_MESSAGE"]) {
    await t.test(`legacy ${event} gets ERROR AUTH_REQUIRED and does nothing`, async () => {
      const client = await connected(server.client(undefined));
      const error = nextEvent(client, "ERROR");
      client.emit(event, textMessage({ userId: oid(), senderId: oid(), receiverId: oid(), conversationId: oid() }));
      const payload = await error;
      assert.strictEqual(payload.code, "AUTH_REQUIRED");
      assert.strictEqual(payload.event, event);
      await settle();
      assert.strictEqual(server.calls.published.length, 0);
      assert.strictEqual(server.calls.private.length + server.calls.group.length, 0);
      assert.strictEqual(logged("legacy_socket", { event, socketId: client.id, action: "refused" }).length, 1);
    });
  }

  await t.test("a verified socket works as usual", async () => {
    const me = oid();
    const client = await connected(server.client({ token: tokenFor(me) }));
    client.emit("SETUP", {});
    await until(() => server.serverSocket(client)?.rooms.has(me));
    client.emit("NEW_MESSAGE", textMessage({ receiverId: oid() }));
    await until(() => server.calls.private.length === 1);
    assert.strictEqual(server.calls.private[0].senderId, me);
  });

  await server.close();
});

// ---------------------------------------------------------------- delivery

test("presence goes to conversation partners only", async (t) => {
  const server = await startServer("permissive");
  const partner = oid();
  const stranger = oid();
  const partnerClient = await connected(server.client({ token: tokenFor(partner) }));
  const strangerClient = await connected(server.client({ token: tokenFor(stranger) }));
  partnerClient.emit("SETUP", {});
  strangerClient.emit("SETUP", {});
  await until(() => server.serverSocket(partnerClient)?.rooms.has(partner));
  await until(() => server.serverSocket(strangerClient)?.rooms.has(stranger));

  await t.test("a partner hears USER_ONLINE; a stranger does not", async () => {
    const heard = nextEvent(partnerClient, "CONVERSATION_LISTENING");
    const quiet = noEvent(strangerClient, "CONVERSATION_LISTENING");
    const userId = oid();
    emitPresence(server.io, [partner], { userId, isOnline: true });
    assert.deepStrictEqual(await heard, { type: "USER_ONLINE", response: { userId, isOnline: true } });
    await quiet;
  });

  await t.test("no partners means nobody hears it (io.to([]) would have been everyone)", async () => {
    const quietA = noEvent(partnerClient, "CONVERSATION_LISTENING");
    const quietB = noEvent(strangerClient, "CONVERSATION_LISTENING");
    emitPresence(server.io, [], { userId: oid(), isOnline: false });
    emitPresence(server.io, undefined, { userId: oid(), isOnline: false });
    await Promise.all([quietA, quietB]);
  });

  await server.close();
});

test("routePayment", async (t) => {
  const userId = oid();
  const referenceId = oid();

  await t.test("a payment goes to its payer's room only", () => {
    const data = { _id: oid(), userId, type: "CREDIT_PURCHASE", status: "SUCCESS", amount: 1000 };
    for (const mode of ["permissive", "enforce"]) {
      assert.deepStrictEqual(routePayment(data, mode), [{ to: userId, payload: { type: "PAYMENT", response: data } }]);
    }
  });

  await t.test("a payment without a userId goes nowhere", () => {
    assert.deepStrictEqual(routePayment({ type: "CREDIT_PURCHASE" }, "permissive"), []);
  });

  await t.test("permissive: a signed-in donation goes to the donor, and a trimmed broadcast to everyone else", () => {
    const data = { _id: oid(), userId, type: "DONATE", status: "SUCCESS", referenceId, amount: 50000 };
    assert.deepStrictEqual(routePayment(data, "permissive"), [
      { to: userId, payload: { type: "PAYMENT", response: data } },
      {
        broadcast: true,
        except: [userId],
        payload: { type: "PAYMENT", response: { type: "DONATE", referenceId, status: "SUCCESS" } },
      },
    ]);
  });

  await t.test("permissive: an anonymous donation is broadcast trimmed, as before", () => {
    const data = { _id: oid(), type: "DONATE", status: "SUCCESS", referenceId, amount: 50000 };
    assert.deepStrictEqual(routePayment(data, "permissive"), [
      {
        broadcast: true,
        except: [],
        payload: { type: "PAYMENT", response: { type: "DONATE", referenceId, status: "SUCCESS" } },
      },
    ]);
  });

  await t.test("enforce: no broadcast; a signed-in donation reaches its donor, an anonymous one nobody", () => {
    const signedIn = { userId, type: "DONATE", status: "SUCCESS", referenceId };
    assert.deepStrictEqual(routePayment(signedIn, "enforce"), [
      { to: userId, payload: { type: "PAYMENT", response: signedIn } },
    ]);
    assert.deepStrictEqual(routePayment({ type: "DONATE", status: "SUCCESS", referenceId }, "enforce"), []);
  });

  await t.test("deliverPayment: the donor gets the full event once, others the trimmed one", async () => {
    const server = await startServer("permissive");
    const donor = await connected(server.client({ token: tokenFor(userId) }));
    const other = await connected(server.client({ token: tokenFor(oid()) }));
    donor.emit("SETUP", {});
    await until(() => server.serverSocket(donor)?.rooms.has(userId));

    const donorEvents = [];
    donor.on("LISTENING", (event) => donorEvents.push(event));
    const otherEvent = nextEvent(other, "LISTENING");
    const data = { _id: oid(), userId, type: "DONATE", status: "SUCCESS", referenceId, amount: 50000 };
    deliverPayment(server.io, routePayment(data, "permissive"));

    assert.deepStrictEqual(await otherEvent, {
      type: "PAYMENT",
      response: { type: "DONATE", referenceId, status: "SUCCESS" },
    });
    await settle();
    assert.deepStrictEqual(donorEvents, [{ type: "PAYMENT", response: data }]);
    await server.close();
  });
});
