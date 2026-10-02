/**
 * A real socket.io server and clients around registerSocketHandlers, with
 * Redis and Mongo replaced through SocketDeps (the harness socket-auth.test.js
 * has inline, shared here by the reply, reaction and typing tests).
 *
 * - `publish` records what would go on Redis and does what the Redis
 *   subscribers in config/redis.ts do with it on this instance.
 * - Membership, messages and writes come from in-memory maps, or from `deps`
 *   overrides.
 * - JSON log lines (logEvent) are collected in `logs`.
 *
 * Not a test file (node --test only picks up *.test.js here).
 */
const http = require("node:http");
const { after } = require("node:test");
const { Server } = require("socket.io");
const { io: connect } = require("socket.io-client");
const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || "test-secret";
const SECRET = process.env.JWT_SECRET_KEY;

const { registerSocketHandlers } = require("../../dist/socket/handlers.js");
const rooms = require("../../dist/socket/rooms.js");

const oid = () => new Types.ObjectId().toString();
const tokenFor = (userId, options = { expiresIn: "1h" }) => jwt.sign({ userId }, SECRET, options);
const STICKER_PREFIX = "https://seemuehub-storage.s3.ap-southeast-1.amazonaws.com/images/";

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

/** Everything `client` receives on `event` from now on. */
const collect = (client, event) => {
  const received = [];
  client.on(event, (data) => received.push(data));
  return received;
};

const connected = (client) =>
  new Promise((resolve, reject) => {
    client.once("connect", () => resolve(client));
    client.once("connect_error", (err) => reject(err));
  });

/**
 * Servers still open when the file's tests end (a failed assertion skips a
 * test's own close): closed here, so a failure fails the file instead of
 * keeping its process alive.
 */
const open = new Set();
after(async () => {
  for (const server of [...open]) await server.close();
});

/**
 * @param {object} options
 * @param {"permissive"|"enforce"} [options.mode]
 * @param {object} [options.deps] SocketDeps overrides
 */
async function startServer({ mode = "permissive", deps = {} } = {}) {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  const calls = { published: [], private: [], group: [], lookups: [], pushes: [] };
  /** conversationId -> [{ userId, isMuted }] */
  const members = new Map();

  const membersOf = async (conversationId, userId) => {
    calls.lookups.push({ conversationId, userId });
    const list = members.get(conversationId);
    if (!list || !list.some((member) => member.userId === userId)) return null;
    return list.map((member) => ({ ...member }));
  };

  registerSocketHandlers(io, {
    mode,
    publish: (channel, message) => {
      const parsed = JSON.parse(message);
      calls.published.push({ channel, message: parsed });
      // What the Redis subscribers (config/redis.ts) do on this instance.
      if (channel === "SETUP") rooms.joinSetupRooms(io, parsed);
      if (channel === "REACTION" && rooms.deliverReaction) rooms.deliverReaction(io, parsed);
      if (channel === "TYPING" && rooms.deliverTyping) rooms.deliverTyping(io, parsed);
    },
    isParticipant: async (conversationId, userId) => (members.get(conversationId) ?? []).some((m) => m.userId === userId),
    conversationPartners: async () => [],
    membersOf,
    sendPrivateMessage: async (_socket, _io, data) => {
      calls.private.push(data);
    },
    sendGroupMessage: async (_socket, _io, data) => {
      calls.group.push(data);
    },
    pushReaction: (push) => {
      calls.pushes.push(push);
    },
    stickerUrlPrefix: STICKER_PREFIX,
    ...deps,
  });

  await new Promise((r) => httpServer.listen(0, r));
  const url = `http://localhost:${httpServer.address().port}`;
  const clients = [];

  const server = {
    io,
    calls,
    /** Sets a conversation's participants: user ids, or { userId, isMuted }. */
    setMembers(conversationId, list) {
      members.set(
        conversationId,
        list.map((entry) => (typeof entry === "string" ? { userId: entry, isMuted: false } : { isMuted: false, ...entry }))
      );
    },
    /** A client; `auth` undefined means a legacy client that sends none. */
    client(auth) {
      const client = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false, auth });
      clients.push(client);
      return client;
    },
    /** A verified client that has completed SETUP (so it is in its user's room). */
    async userClient(userId) {
      const client = await connected(this.client({ token: tokenFor(userId) }));
      client.emit("SETUP", {});
      await until(() => io.sockets.sockets.get(client.id)?.rooms.has(userId));
      return client;
    },
    serverSocket: (client) => io.sockets.sockets.get(client.id),
    published: (channel) => calls.published.filter((p) => p.channel === channel).map((p) => p.message),
    async close() {
      if (!open.delete(server)) return;
      for (const client of clients) client.disconnect();
      io.close();
      await settle(20);
    },
  };
  open.add(server);
  return server;
}

module.exports = {
  STICKER_PREFIX,
  collect,
  connected,
  logged,
  logs,
  nextEvent,
  oid,
  settle,
  startServer,
  tokenFor,
  until,
};
