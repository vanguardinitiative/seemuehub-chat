/**
 * The one thing a socket without a token may do in enforce mode: follow the
 * outcome of one anonymous donation it names (FOLLOW_DONATION { referenceId }),
 * so the signed-out donate page can still say "payment received".
 *
 * Against dist/ over a real socket.io server (tests/helpers/socket-harness.js);
 * the payment lookup is a SocketDeps stub, and the production lookup is checked
 * on its own at the end with the model stubbed (tests/helpers/offline.js).
 * Run with: npm test
 */
const { stub, query } = require("./helpers/offline");
const harness = require("./helpers/socket-harness");

const test = require("node:test");
const assert = require("node:assert");

const { routePayment, deliverPayment } = require("../dist/socket/rooms.js");
const { DONATION_FOLLOW_WINDOW_MS } = require("../dist/socket/donation-follow.js");
const { findDonationPayment } = require("../dist/services/donation-payments.js");
const { paymentModel } = require("../dist/models/payment.js");

const { oid, connected, nextEvent, collect, settle, until, tokenFor } = harness;
const MINUTE = 60_000;

/** The payments the stubbed lookup knows, by referenceId. */
const payments = new Map();
/** An anonymous donation as the backend stores it, created `ageMs` ago. */
const donation = (extra = {}, ageMs = MINUTE) => {
  const referenceId = oid();
  payments.set(referenceId, { _id: oid(), type: "DONATE", status: "PENDING", createdAt: new Date(Date.now() - ageMs), ...extra });
  return referenceId;
};

/** What POST /core-socket/payment gets from the backend (chatPaymentPayload) for a paid donation. */
const backendPayment = (referenceId, extra = {}) => ({
  _id: oid(),
  type: "DONATE",
  status: "COMPLETED",
  amount: 50000,
  subtotalAmount: 49000,
  processingFeeAmount: 1000,
  currency: "LAK",
  referenceId,
  description: "For the school",
  paymentProvider: "IB",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...extra,
});

const roomOf = (referenceId) => `donation:${referenceId}`;
const ipHeaders = (ip) => ({ extraHeaders: { "cf-connecting-ip": ip } });

let ipCounter = 0;
/** A fresh client address per call, so the per-IP limits never mix tests. */
const freshIp = () => `198.51.100.${++ipCounter}`;

const startServer = (extra = {}) =>
  harness.startServer({
    mode: "enforce",
    deps: {
      findDonationPayment: async (referenceId) => payments.get(referenceId) ?? null,
      ...extra,
    },
  });

/** An anonymous socket from a fresh address. */
const anonymous = (server, ip = freshIp()) => connected(server.client(undefined, ipHeaders(ip)));

/** FOLLOW_DONATION, resolving to the ERROR it got, or null when none came. */
const follow = async (client, referenceId) => {
  const errors = collect(client, "ERROR");
  client.emit("FOLLOW_DONATION", { referenceId });
  await settle();
  client.off("ERROR");
  return errors[0] ?? null;
};

// ---------------------------------------------------------------- following

test("an anonymous socket can follow its own donation's payment", async (t) => {
  const server = await startServer();
  try {
    await t.test("it joins that donation's room, and only that one", async () => {
      const referenceId = donation();
      const client = await anonymous(server);
      assert.strictEqual(await follow(client, referenceId), null);
      const rooms = [...server.serverSocket(client).rooms].filter((room) => room !== client.id);
      assert.deepStrictEqual(rooms, [roomOf(referenceId)]);
      assert.strictEqual(harness.logged("donation_followed", { socketId: client.id }).length, 1);
    });

    await t.test("its payment event arrives with only what the page shows: type, referenceId, status", async () => {
      const referenceId = donation();
      const client = await anonymous(server);
      await follow(client, referenceId);
      const event = nextEvent(client, "LISTENING");
      deliverPayment(server.io, routePayment(backendPayment(referenceId), "enforce"));
      assert.deepStrictEqual(await event, {
        type: "PAYMENT",
        response: { type: "DONATE", referenceId, status: "COMPLETED" },
      });
    });

    await t.test("nobody else hears it: not another anonymous socket, not one following another donation", async () => {
      const mine = donation();
      const theirs = donation();
      const follower = await anonymous(server);
      const other = await anonymous(server);
      const bystander = await anonymous(server);
      await follow(follower, mine);
      await follow(other, theirs);
      const heard = { follower: collect(follower, "LISTENING"), other: collect(other, "LISTENING"), bystander: collect(bystander, "LISTENING") };
      deliverPayment(server.io, routePayment(backendPayment(mine), "enforce"));
      await settle();
      assert.strictEqual(heard.follower.length, 1);
      assert.deepStrictEqual(heard.other, []);
      assert.deepStrictEqual(heard.bystander, []);
    });

    await t.test("a donation that failed once (the payer may retry the same QR) can still be followed", async () => {
      const client = await anonymous(server);
      const referenceId = donation({ status: "FAILED" });
      assert.strictEqual(await follow(client, referenceId), null);
      assert.ok(server.serverSocket(client).rooms.has(roomOf(referenceId)));
    });

    await t.test("naming the same donation again is harmless", async () => {
      const referenceId = donation();
      const client = await anonymous(server);
      assert.strictEqual(await follow(client, referenceId), null);
      assert.strictEqual(await follow(client, referenceId), null);
      assert.ok(server.serverSocket(client).rooms.has(roomOf(referenceId)));
    });
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- refusals

test("FOLLOW_DONATION is refused for anything but a recent anonymous donation", async (t) => {
  const server = await startServer();
  try {
    const refusals = [
      ["a payment that is not a donation", () => donation({ type: "WALLET_TRANSACTION" })],
      ["an unknown id", () => oid()],
      ["an id that is not an ObjectId", () => "12345"],
      ["an object instead of an id", () => ({ $ne: null })],
      ["a donation older than the window", () => donation({}, DONATION_FOLLOW_WINDOW_MS + MINUTE)],
      ["a donation already paid", () => donation({ status: "COMPLETED" })],
      ["a donation cancelled or expired", () => donation({ status: "EXPIRED" })],
      ["a signed-in donor's donation (it reaches the donor's own room)", () => donation({ userId: oid() })],
    ];
    for (const [name, referenceIdOf] of refusals) {
      await t.test(`${name}: DONATION_NOT_FOLLOWABLE, no room joined`, async () => {
        const client = await anonymous(server);
        const error = await follow(client, referenceIdOf());
        assert.strictEqual(error?.code, "DONATION_NOT_FOLLOWABLE");
        assert.strictEqual(error.event, "FOLLOW_DONATION");
        assert.deepStrictEqual([...server.serverSocket(client).rooms], [client.id]);
      });
    }

    await t.test("a second, different donation on the same socket", async () => {
      const client = await anonymous(server);
      const first = donation();
      assert.strictEqual(await follow(client, first), null);
      const error = await follow(client, donation());
      assert.strictEqual(error?.code, "DONATION_NOT_FOLLOWABLE");
      assert.deepStrictEqual([...server.serverSocket(client).rooms].filter((room) => room !== client.id), [roomOf(first)]);
    });

    await t.test("a socket with a token (it hears its donations in its own room)", async () => {
      const client = await connected(server.client({ token: tokenFor(oid()) }, ipHeaders(freshIp())));
      const error = await follow(client, donation());
      assert.strictEqual(error?.code, "DONATION_NOT_FOLLOWABLE");
    });

    await t.test("every refusal answers the same, so the answer says nothing about which ids exist", async () => {
      const codes = new Set();
      for (const referenceId of [oid(), donation({ type: "ORDER_PAYMENT" }), donation({ userId: oid() }), donation({ status: "COMPLETED" })]) {
        const client = await anonymous(server);
        const error = await follow(client, referenceId);
        codes.add(JSON.stringify({ code: error.code, message: error.message }));
      }
      assert.strictEqual(codes.size, 1);
    });
  } finally {
    await server.close();
  }
});

test("a socket following a donation can do nothing else", async (t) => {
  const server = await startServer();
  try {
    const client = await anonymous(server);
    const referenceId = donation();
    await follow(client, referenceId);
    const conversationId = oid();
    const userId = oid();
    server.setMembers(conversationId, [userId]);

    const attempts = [
      ["a user room (SETUP)", "SETUP", { userId }],
      ["a conversation room (SETUP)", "SETUP", { userId, conversationId }],
      ["NEW_MESSAGE", "NEW_MESSAGE", { messageType: "TEXT", content: "hi", senderId: userId, receiverId: oid() }],
      ["NEW_GROUP_MESSAGE", "NEW_GROUP_MESSAGE", { messageType: "TEXT", content: "hi", senderId: userId, conversationId }],
      ["REACT_MESSAGE", "REACT_MESSAGE", { messageId: oid(), emoji: null }],
      ["TYPING", "TYPING", { conversationId, typing: true }],
      ["DELIVERED", "DELIVERED", { conversationId }],
    ];
    for (const [name, event, payload] of attempts) {
      await t.test(`${name}: AUTH_REQUIRED, nothing joined, published or sent`, async () => {
        const published = server.calls.published.length;
        const error = nextEvent(client, "ERROR");
        client.emit(event, payload);
        assert.strictEqual((await error).code, "AUTH_REQUIRED");
        await settle();
        assert.strictEqual(server.calls.published.length, published);
        assert.strictEqual(server.calls.private.length + server.calls.group.length, 0);
        assert.deepStrictEqual([...server.serverSocket(client).rooms].filter((room) => room !== client.id), [roomOf(referenceId)]);
      });
    }
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- per-IP limits

test("per-IP limits for sockets without a token", async (t) => {
  const limits = { connections: { limit: 3, windowMs: MINUTE }, follows: { limit: 2, windowMs: MINUTE } };
  const server = await startServer({ anonymousLimits: limits });
  try {
    await t.test("connections: past the limit from one address, the handshake is refused with RATE_LIMITED", async () => {
      const ip = freshIp();
      for (let i = 0; i < limits.connections.limit; i++) await anonymous(server, ip);
      const refused = await new Promise((resolve, reject) => {
        const client = server.client(undefined, ipHeaders(ip));
        client.once("connect", () => reject(new Error("connected, expected connect_error")));
        client.once("connect_error", resolve);
      });
      assert.strictEqual(refused.message, "RATE_LIMITED");
      assert.deepStrictEqual(refused.data, { code: "RATE_LIMITED" });
    });

    await t.test("connections: another address, and a socket with a token from the same one, are not held back", async () => {
      const ip = freshIp();
      for (let i = 0; i < limits.connections.limit; i++) await anonymous(server, ip);
      await anonymous(server, freshIp());
      await connected(server.client({ token: tokenFor(oid()) }, ipHeaders(ip)));
    });

    await t.test("follows: past the limit from one address, RATE_LIMITED, even for a real donation", async () => {
      const ip = freshIp();
      for (let i = 0; i < limits.follows.limit; i++) {
        const client = await anonymous(server, ip);
        assert.strictEqual(await follow(client, donation()), null);
      }
      // A new connection from the same address (still under the connection
      // limit): the follow limit counts by address, not by socket.
      const late = await anonymous(server, ip);
      const error = await follow(late, donation());
      assert.strictEqual(error?.code, "RATE_LIMITED");
      assert.deepStrictEqual([...server.serverSocket(late).rooms], [late.id]);
    });

    await t.test("refused follows count too, so ids cannot be tried without limit", async () => {
      const ip = freshIp();
      const client = await anonymous(server, ip);
      for (let i = 0; i < limits.follows.limit; i++) assert.strictEqual((await follow(client, oid()))?.code, "DONATION_NOT_FOLLOWABLE");
      assert.strictEqual((await follow(client, donation()))?.code, "RATE_LIMITED");
    });
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- routing

test("routePayment: an anonymous donation goes to its followers' room", async (t) => {
  const referenceId = oid();

  await t.test("enforce: to the donation's room, trimmed to type, referenceId and status", () => {
    assert.deepStrictEqual(routePayment(backendPayment(referenceId), "enforce"), [
      { to: roomOf(referenceId), payload: { type: "PAYMENT", response: { type: "DONATE", referenceId, status: "COMPLETED" } } },
    ]);
  });

  await t.test("a signed-in donation still goes to its donor's room only", () => {
    const userId = oid();
    const data = backendPayment(referenceId, { userId });
    assert.deepStrictEqual(routePayment(data, "enforce"), [{ to: userId, payload: { type: "PAYMENT", response: data } }]);
  });

  await t.test("a donation without a usable referenceId goes nowhere", () => {
    assert.deepStrictEqual(routePayment(backendPayment("not-an-id"), "enforce"), []);
  });

  await t.test("permissive: the room, plus the old trimmed broadcast to everyone outside it", () => {
    const trimmed = { type: "PAYMENT", response: { type: "DONATE", referenceId, status: "COMPLETED" } };
    assert.deepStrictEqual(routePayment(backendPayment(referenceId), "permissive"), [
      { to: roomOf(referenceId), payload: trimmed },
      { broadcast: true, except: [roomOf(referenceId)], payload: trimmed },
    ]);
  });
});

// ---------------------------------------------------------------- the production lookup

test("findDonationPayment reads one DONATE payment by referenceId, and none of its money or text", async (t) => {
  await t.test("the filter names the type and a string id; the selection is the four fields the check needs", async () => {
    const seen = [];
    const restore = stub(paymentModel, "findOne", (filter) => {
      const chain = query({ type: "DONATE", status: "PENDING" });
      chain.select = (fields) => {
        seen.push({ filter, fields });
        return chain;
      };
      return chain;
    });
    try {
      const referenceId = oid();
      assert.deepStrictEqual(await findDonationPayment(referenceId), { type: "DONATE", status: "PENDING" });
      assert.deepStrictEqual(seen[0].filter, { referenceId, type: "DONATE" });
      assert.deepStrictEqual(seen[0].fields.split(/\s+/).sort(), ["createdAt", "status", "type", "userId"]);
    } finally {
      restore();
    }
  });

  await t.test("anything but an ObjectId string is not looked up", async () => {
    let calls = 0;
    const restore = stub(paymentModel, "findOne", () => {
      calls += 1;
      return query(null);
    });
    try {
      for (const value of [{ $ne: null }, "12345", undefined, ["a"]]) assert.strictEqual(await findDonationPayment(value), null);
      assert.strictEqual(calls, 0);
    } finally {
      restore();
    }
  });
});
