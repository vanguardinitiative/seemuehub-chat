/**
 * Who may open a conversation, and what goes into its Mongo query, against
 * the compiled dist/ with no Redis and no Mongo (tests/helpers/offline.js):
 * npm test
 *
 * - POST /conversations/group needs a token, takes the sender from it, and
 *   answers the participants without their contact details.
 * - POST /conversations/private and GET /messages/histories put only id
 *   strings into their queries: an object such as {"$ne": null} is a 400.
 */
const { stub } = require("./helpers/offline");

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");

const router = require("../dist/routes/index.js").default;
const { conversationModel } = require("../dist/models/conversation.js");
const { staffModel } = require("../dist/models/staff.js");

const oid = () => new Types.ObjectId().toString();
const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET_KEY, { expiresIn: "1h" });

const app = express();
app.use(express.json());
app.use("/v1/api", router);

const listen = () => new Promise((resolve) => { const server = app.listen(0, () => resolve(server)); });
const request = (port, method, url, { headers = {}, body } = {}) =>
  new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        port,
        path: url,
        method,
        headers: { ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}), ...headers },
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

/**
 * Stubs the conversation and staff lookups the two POST routes make, and
 * records each one: the filter, and the fields every populate asked for.
 * `existing` is what conversationModel.findOne answers.
 */
const recordQueries = ({ existing = null } = {}) => {
  const seen = { finds: [], populates: [], creates: [], staff: [] };
  const chain = (result) => {
    const self = {
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      populate: (path, fields) => {
        seen.populates.push({ path, fields });
        return self;
      },
      select: () => self,
      lean: () => self,
    };
    return self;
  };
  const restores = [
    stub(conversationModel, "findOne", (filter) => {
      seen.finds.push(filter);
      return chain(existing ?? (seen.creates.length > 0 ? { _id: seen.creates[0]._id, ...seen.creates[0] } : null));
    }),
    stub(conversationModel, "create", async (doc) => {
      const created = { _id: oid(), ...doc };
      seen.creates.push(created);
      return created;
    }),
    stub(staffModel, "findById", (id) => {
      seen.staff.push(id);
      return chain(null);
    }),
    stub(staffModel, "find", () => chain([])),
  ];
  return { seen, restore: () => restores.forEach((restore) => restore()) };
};

/** The user ids a participants.$all filter names. */
const allUsers = (filter) => (filter?.participants?.$all ?? []).map((clause) => clause.$elemMatch.user);

/** Every field name a populate selection string asks for. */
const fieldsOf = (populates) => populates.flatMap((p) => String(p.fields).split(/\s+/).filter(Boolean));
const CONTACT_FIELDS = ["phone", "email", "role"];

// ---------------------------------------------------------------- /conversations/group

test("POST /conversations/group", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const me = oid();

  await t.test("no token: 401, and no query runs", async () => {
    const { seen, restore } = recordQueries();
    try {
      const res = await request(port, "POST", "/v1/api/conversations/group", { body: { senderId: oid() } });
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(seen.finds, []);
      assert.deepStrictEqual(seen.creates, []);
    } finally {
      restore();
    }
  });

  await t.test('an operator for senderId ({"$ne": null}) is a 400, and no query runs', async () => {
    const { seen, restore } = recordQueries();
    try {
      const res = await request(port, "POST", "/v1/api/conversations/group", {
        headers: { Authorization: `Bearer ${tokenFor(me)}` },
        body: { senderId: { $ne: null } },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "CHAT-400");
      assert.deepStrictEqual(seen.finds, []);
      assert.deepStrictEqual(seen.creates, []);
    } finally {
      restore();
    }
  });

  await t.test("a platform that is not a string is a 400", async () => {
    const { seen, restore } = recordQueries();
    try {
      const res = await request(port, "POST", "/v1/api/conversations/group", {
        headers: { Authorization: `Bearer ${tokenFor(me)}` },
        body: { platform: { $gt: "" } },
      });
      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(seen.finds, []);
    } finally {
      restore();
    }
  });

  await t.test("the sender is the token's user, whatever senderId the body names", async () => {
    const { seen, restore } = recordQueries();
    try {
      const res = await request(port, "POST", "/v1/api/conversations/group", {
        headers: { Authorization: `Bearer ${tokenFor(me)}` },
        body: { senderId: oid(), platform: "EXPRESS" },
      });
      assert.strictEqual(res.status, 201);
      assert.deepStrictEqual(allUsers(seen.finds[0]).map(String), [me]);
      assert.deepStrictEqual(seen.staff.map(String), [me]);
      assert.strictEqual(String(seen.creates[0].participants[0].user), me);
    } finally {
      restore();
    }
  });

  await t.test("the support group it finds goes out without phone, email or role", async () => {
    const existing = { _id: oid(), conversationType: "GROUP", participants: [{ user: { _id: me, displayName: "Me" } }] };
    const { seen, restore } = recordQueries({ existing });
    try {
      const res = await request(port, "POST", "/v1/api/conversations/group", { headers: { Authorization: `Bearer ${tokenFor(me)}` }, body: {} });
      assert.strictEqual(res.status, 200);
      assert.ok(seen.populates.length > 0, "participants are populated");
      for (const field of CONTACT_FIELDS) assert.ok(!fieldsOf(seen.populates).includes(field), `${field} is not populated`);
    } finally {
      restore();
    }
  });

  await t.test("a support group it creates goes out without phone, email or role", async () => {
    const { seen, restore } = recordQueries();
    try {
      const res = await request(port, "POST", "/v1/api/conversations/group", { headers: { Authorization: `Bearer ${tokenFor(me)}` }, body: {} });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(seen.creates.length, 1);
      assert.ok(seen.populates.length > 0, "participants are populated");
      for (const field of CONTACT_FIELDS) assert.ok(!fieldsOf(seen.populates).includes(field), `${field} is not populated`);
    } finally {
      restore();
    }
  });

  server.close();
});

// ---------------------------------------------------------------- /conversations/private

test("POST /conversations/private puts only id strings into its query", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const me = oid();
  const auth = { Authorization: `Bearer ${tokenFor(me)}` };

  const refusedBodies = [
    ["receiverId", { receiverId: { $ne: null } }],
    ["orderId", { receiverId: oid(), orderId: { $ne: null } }],
    ["senderId", { receiverId: oid(), senderId: { $ne: null } }],
    ["a receiverId that is not an ObjectId", { receiverId: "someone" }],
  ];
  for (const [name, body] of refusedBodies) {
    await t.test(`${name}: 400, and no query runs`, async () => {
      const { seen, restore } = recordQueries();
      try {
        const res = await request(port, "POST", "/v1/api/conversations/private", { headers: auth, body });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, "CHAT-400");
        assert.deepStrictEqual(seen.finds, []);
      } finally {
        restore();
      }
    });
  }

  await t.test("the clients' own body still finds the order's conversation of the token's user", async () => {
    const receiverId = oid();
    const orderId = oid();
    const { seen, restore } = recordQueries({ existing: { _id: oid() } });
    try {
      // seemuehub-mobile createForOrder: senderId (the caller) and order fields too.
      const res = await request(port, "POST", "/v1/api/conversations/private", {
        headers: auth,
        body: { senderId: me, receiverId, orderId, orderTitle: "Logo", orderBudget: { amount: 1, currency: "LAK" }, orderStatus: "PENDING" },
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(seen.finds.length, 1);
      assert.strictEqual(seen.finds[0].orderId, orderId);
      assert.deepStrictEqual(allUsers(seen.finds[0]).map(String), [me, receiverId]);
    } finally {
      restore();
    }
  });

  await t.test("no receiverId is still the 400 it was", async () => {
    const { restore } = recordQueries();
    try {
      const res = await request(port, "POST", "/v1/api/conversations/private", { headers: auth, body: { orderId: oid() } });
      assert.strictEqual(res.status, 400);
    } finally {
      restore();
    }
  });

  server.close();
});

// ---------------------------------------------------------------- /messages/histories

test("GET /messages/histories takes one orderId string", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const auth = { Authorization: `Bearer ${tokenFor(oid())}` };

  await t.test("orderId given twice (an array in the query) is a 400, and no query runs", async () => {
    const { seen, restore } = recordQueries();
    try {
      const res = await request(port, "GET", `/v1/api/messages/histories?orderId=${oid()}&orderId=${oid()}`, { headers: auth });
      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(seen.finds, []);
    } finally {
      restore();
    }
  });

  await t.test("an orderId that is not an ObjectId is a 400, and no query runs", async () => {
    const { seen, restore } = recordQueries();
    try {
      const res = await request(port, "GET", "/v1/api/messages/histories?orderId=abc", { headers: auth });
      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(seen.finds, []);
    } finally {
      restore();
    }
  });

  server.close();
});
