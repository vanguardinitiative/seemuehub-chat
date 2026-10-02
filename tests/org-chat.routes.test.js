/**
 * Company ↔ candidate chat over REST (worktrees/ORG-CHAT-CONTRACT.md §3.2,
 * §3.5), against the compiled dist/ with no Redis, no Mongo and no backend
 * (tests/helpers/offline.js, tests/helpers/org-chat-fakes.js): npm test
 *
 * - open: refused without a basis, with a block, over the cap; twice is one
 *   conversation; the backend unreachable is a 503.
 * - a company message reaches the candidate (SEND_MESSAGE, push CANDIDATE);
 *   the candidate's reply reaches the company (push ORGANIZATION).
 * - the company's read, the candidate's mute and block.
 * - no conversation is ever .save()d.
 * - ORG_CHAT_ENABLED off: open and the new routes answer ORG_CHAT_DISABLED,
 *   the routes that existed keep their old rule.
 */
const { published, cached, stub, query } = require("./helpers/offline");
const { installBackend, installStore, oid } = require("./helpers/org-chat-fakes");

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const router = require("../dist/routes/index.js").default;
const { env } = require("../dist/config/env.js");

const app = express();
app.use(express.json());
app.use("/v1/api", router);

const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET_KEY, { expiresIn: "1h" });
const listen = () => new Promise((resolve) => { const server = app.listen(0, () => resolve(server)); });
const request = (port, method, url, { as, body } = {}) =>
  new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        port,
        path: url,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(as ? { Authorization: `Bearer ${tokenFor(as)}` } : {}),
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

/** Pushes and the counter are fire and forget: let them land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const ORG = oid();
const MEMBER = oid();
const OTHER_MEMBER = oid();
const CANDIDATE = oid();
const STRANGER = oid();
const JOB = oid();
const ORGANIZATION = { _id: ORG, name: "Lao Coffee Co", nameLao: "ບໍລິສັດ ກາເຟລາວ", logo: "https://cdn.test/logo.png", slug: "lao-coffee" };

/** The backend allows everything for MEMBER and OTHER_MEMBER, and nothing for anyone else. */
const allowMembers = (body) => {
  if (![MEMBER, OTHER_MEMBER].includes(body.actorUserId)) return { allow: false, code: "ORG_CHAT_NOT_MEMBER", organization: ORGANIZATION };
  if (body.action !== "OPEN") return { allow: true, organization: ORGANIZATION };
  return { allow: true, basis: body.basis, ...(body.basis === "APPLICATION" ? { jobId: JOB } : {}), organization: ORGANIZATION, remainingToday: 49 };
};

/** Everything a test needs, switched on; `restore` puts it all back. */
const setup = ({ enabled = "true", authorize = allowMembers, seed, backend = {} } = {}) => {
  published.length = 0;
  cached.clear();
  const store = installStore(seed);
  const fakeBackend = installBackend({ authorize, ...backend });
  const restores = [
    stub(env, "ORG_CHAT_ENABLED", enabled),
    stub(env, "BACKEND_URL", "https://api.test"),
    stub(env, "CHAT_INTERNAL_KEY", "test-key"),
  ];
  return {
    ...store,
    backend: fakeBackend,
    restore: () => {
      restores.reverse().forEach((undo) => undo());
      fakeBackend.restore();
      store.restore();
    },
  };
};

const openBody = (overrides = {}) => ({ candidateUserId: CANDIDATE, basis: "APPLICATION", firstMessage: "ສະບາຍດີ, we liked your application", ...overrides });
const open = (port, body = openBody(), as = MEMBER) => request(port, "POST", `/v1/api/organizations/${ORG}/conversations`, { as, body });

/** A company conversation as it is stored after an open. */
const orgConversation = (overrides = {}) => ({
  _id: oid(),
  conversationType: "PRIVATE",
  organizationId: ORG,
  candidateUserId: CANDIDATE,
  participants: [{ user: CANDIDATE, userType: "USER", isMuted: false }],
  organization: { name: ORGANIZATION.name, nameLao: ORGANIZATION.nameLao, logo: ORGANIZATION.logo, slug: ORGANIZATION.slug },
  conversationName: ORGANIZATION.nameLao,
  basis: "APPLICATION",
  openedBy: MEMBER,
  latestMessageData: { senderId: MEMBER, messageId: oid(), messageType: "TEXT", content: "hello", sendAt: new Date(Date.now() - 60_000), readAllAt: null, isDeleted: false },
  createdAt: new Date(Date.now() - 120_000),
  updatedAt: new Date(Date.now() - 60_000),
  ...overrides,
});

let server;
let port;
test.before(async () => {
  server = await listen();
  port = server.address().port;
});
test.after(() => server.close());

// ---------------------------------------------------------------- open

test("POST /organizations/:id/conversations: open", async (t) => {
  await t.test("creates the conversation with the company's first message (201)", async () => {
    const world = setup();
    try {
      const res = await open(port);
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      const { conversation, message } = res.body.data;

      assert.strictEqual(world.db.conversations.length, 1);
      assert.strictEqual(world.db.messages.length, 1);
      assert.deepStrictEqual(
        { ...conversation, _id: undefined, createdAt: undefined, updatedAt: undefined, participants: undefined, latestMessageData: undefined },
        {
          _id: undefined,
          createdAt: undefined,
          updatedAt: undefined,
          participants: undefined,
          latestMessageData: undefined,
          conversationType: "PRIVATE",
          organizationId: ORG,
          candidateUserId: CANDIDATE,
          organization: { name: "Lao Coffee Co", nameLao: "ບໍລິສັດ ກາເຟລາວ", logo: "https://cdn.test/logo.png", slug: "lao-coffee" },
          // What old clients show when they find no other participant.
          conversationName: "ບໍລິສັດ ກາເຟລາວ",
          conversationImage: "https://cdn.test/logo.png",
          basis: "APPLICATION",
          jobId: JOB,
          openedBy: MEMBER,
        }
      );
      // The candidate is the one participant; members never are.
      assert.deepStrictEqual(conversation.participants.map((p) => [p.user, p.userType]), [[CANDIDATE, "USER"]]);
      assert.strictEqual(conversation.latestMessageData.messageId, message._id);
      assert.strictEqual(conversation.latestMessageData.senderId, MEMBER);

      assert.strictEqual(message.sender, MEMBER);
      assert.strictEqual(message.actorUserId, MEMBER);
      assert.strictEqual(message.sendAsOrganizationId, ORG);
      assert.strictEqual(message.conversation, conversation._id);
      assert.strictEqual(message.messageType, "TEXT");
      assert.strictEqual(message.content, "ສະບາຍດີ, we liked your application");

      await settle();
      // OPEN uncached, then counted once it exists.
      assert.deepStrictEqual(world.backend.authorizations(), [
        { action: "OPEN", organizationId: ORG, actorUserId: MEMBER, candidateUserId: CANDIDATE, basis: "APPLICATION" },
      ]);
      assert.deepStrictEqual(world.backend.opened(), [{ organizationId: ORG }]);
      assert.strictEqual(cached.size, 0, "OPEN is never cached");
    } finally {
      world.restore();
    }
  });

  await t.test("refused without a valid basis, candidate or first message: 400 before the backend is asked", async () => {
    const world = setup();
    try {
      for (const body of [
        openBody({ basis: undefined }),
        openBody({ basis: "FRIENDS" }),
        openBody({ candidateUserId: "nope" }),
        openBody({ firstMessage: "   " }),
        openBody({ firstMessage: "x".repeat(2001) }),
        openBody({ applicationId: "nope" }),
      ]) {
        const res = await open(port, body);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.errors.code, "VALIDATION_ERROR");
      }
      assert.deepStrictEqual(world.backend.calls, []);
      assert.strictEqual(world.db.conversations.length, 0);
    } finally {
      world.restore();
    }
  });

  await t.test("the backend's refusal is the answer, with the contract's status and Lao text; nothing is stored", async () => {
    for (const [code, status, message] of [
      ["ORG_CHAT_NOT_ELIGIBLE", 403, "ແຊັດໄດ້ສະເພາະຜູ້ທີ່ປົດລັອກ CV, ຜູ້ສະໝັກວຽກ ຫຼື ຜູ້ທີ່ເຂົ້າກັນ"],
      ["ORG_CHAT_FORBIDDEN", 403, "ທ່ານບໍ່ມີສິດແຊັດໃນນາມບໍລິສັດ"],
      ["ORG_CHAT_NOT_MEMBER", 403, "ທ່ານບໍ່ແມ່ນສະມາຊິກຂອງບໍລິສັດນີ້"],
      ["ORG_CHAT_BLOCKED", 403, "ຜູ້ສະໝັກໄດ້ບລັອກບໍລິສັດຂອງທ່ານ"],
      ["ORG_CHAT_DAILY_LIMIT", 429, "ມື້ນີ້ເລີ່ມແຊັດໃໝ່ຄົບ 50 ຄົນແລ້ວ ລອງໃໝ່ມື້ອື່ນ"],
      ["ORG_CHAT_DISABLED", 403, "ການແຊັດກັບບໍລິສັດຍັງບໍ່ເປີດໃຫ້ໃຊ້"],
    ]) {
      const world = setup({ authorize: () => ({ allow: false, code, organization: ORGANIZATION, remainingToday: 0 }) });
      try {
        const res = await open(port);
        assert.strictEqual(res.status, status, code);
        assert.deepStrictEqual(res.body, { success: false, errors: { code, message } });
        assert.strictEqual(world.db.conversations.length, 0);
        assert.strictEqual(world.db.messages.length, 0);
        await settle();
        assert.deepStrictEqual(world.backend.opened(), []);
        assert.deepStrictEqual(world.backend.pushes(), []);
      } finally {
        world.restore();
      }
    }
  });

  await t.test("refused when the candidate has blocked the company, even if the backend has not heard yet", async () => {
    const blocked = orgConversation({ candidateBlockedAt: new Date() });
    const world = setup({ seed: { conversations: [blocked] } });
    try {
      const res = await open(port);
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.errors.code, "ORG_CHAT_BLOCKED");
      assert.strictEqual(world.db.messages.length, 0);
    } finally {
      world.restore();
    }
  });

  await t.test("over the cap: 429, but the first message still goes into a conversation that already exists", async () => {
    const atCap = () => ({ allow: false, code: "ORG_CHAT_DAILY_LIMIT", organization: ORGANIZATION, remainingToday: 0 });
    const world = setup({ authorize: atCap });
    try {
      assert.strictEqual((await open(port)).status, 429);
    } finally {
      world.restore();
    }

    const existing = orgConversation();
    const again = setup({ authorize: atCap, seed: { conversations: [existing] } });
    try {
      const res = await open(port);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.conversation._id, existing._id);
      assert.strictEqual(again.db.messages.length, 1);
      await settle();
      assert.deepStrictEqual(again.backend.opened(), [], "an existing conversation is not counted");
    } finally {
      again.restore();
    }
  });

  await t.test("opening twice is one conversation: the second message goes into it (200), counted once", async () => {
    const world = setup();
    try {
      const first = await open(port);
      const second = await open(port, openBody({ firstMessage: "Are you still interested?" }), OTHER_MEMBER);
      assert.strictEqual(first.status, 201);
      assert.strictEqual(second.status, 200);
      assert.strictEqual(second.body.data.conversation._id, first.body.data.conversation._id);
      assert.strictEqual(world.db.conversations.length, 1);
      assert.deepStrictEqual(world.db.messages.map((m) => [m.content, m.actorUserId]), [
        ["ສະບາຍດີ, we liked your application", MEMBER],
        ["Are you still interested?", OTHER_MEMBER],
      ]);
      assert.strictEqual(world.db.conversations[0].latestMessageData.messageId, second.body.data.message._id);
      await settle();
      assert.deepStrictEqual(world.backend.opened(), [{ organizationId: ORG }]);
    } finally {
      world.restore();
    }
  });

  await t.test("two opens at once: the unique pair lets one create, the other sends into it", async () => {
    const world = setup();
    try {
      const results = await Promise.all([open(port), open(port, openBody({ firstMessage: "second" }))]);
      assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 201]);
      assert.strictEqual(world.db.conversations.length, 1);
      assert.strictEqual(world.db.messages.length, 2, "no message left pointing at a conversation that was never made");
      assert.ok(world.db.messages.every((m) => m.conversation === world.db.conversations[0]._id));
    } finally {
      world.restore();
    }
  });

  await t.test("the backend unreachable: 503, nobody contacted", async () => {
    const world = setup({
      authorize: () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
    });
    try {
      const res = await open(port);
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.errors.code, "ORG_CHAT_UNAVAILABLE");
      assert.strictEqual(world.db.conversations.length, 0);
      assert.strictEqual(world.db.messages.length, 0);
    } finally {
      world.restore();
    }
  });
});

// ---------------------------------------------------------------- company send / candidate reply

test("a company message reaches the candidate: SEND_MESSAGE and a CANDIDATE push", async (t) => {
  for (const [label, send] of [
    ["POST /organizations/conversations/:id/messages", (id, body) => request(port, "POST", `/v1/api/organizations/conversations/${id}/messages`, { as: MEMBER, body })],
    ["POST /messages with sendAsOrganizationId", (id, body) => request(port, "POST", "/v1/api/messages", { as: MEMBER, body: { ...body, conversationId: id, sendAsOrganizationId: ORG } })],
  ]) {
    await t.test(label, async () => {
      const conversation = orgConversation();
      const world = setup({ seed: { conversations: [conversation] } });
      try {
        const res = await send(conversation._id, { body: "When can you start?" });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.data.sendAsOrganizationId, ORG);
        assert.strictEqual(res.body.data.actorUserId, MEMBER);

        const [notice] = published.filter((p) => p.channel === "SEND_MESSAGE").map((p) => p.message);
        assert.ok(notice, "published for the sockets");
        assert.strictEqual(notice.conversation.organizationId, ORG);
        assert.deepStrictEqual(notice.conversation.participants.map((p) => p.user), [CANDIDATE]);
        assert.strictEqual(notice.messageData.content, "When can you start?");

        await settle();
        const pushes = world.backend.pushes();
        assert.strictEqual(pushes.length, 1);
        const { messageId, ...body } = pushes[0];
        assert.deepStrictEqual(body, {
          conversationId: conversation._id,
          senderId: MEMBER,
          recipientIds: [CANDIDATE],
          messageType: "TEXT",
          snippet: "When can you start?",
          conversationType: "PRIVATE",
          organizationId: ORG,
          audience: "CANDIDATE",
          senderName: "ບໍລິສັດ ກາເຟລາວ",
        });
        assert.ok(messageId);

        // An update moved the latest message (and the list order); the snapshot was refreshed.
        const stored = world.db.conversations[0];
        assert.strictEqual(stored.latestMessageData.content, "When can you start?");
        assert.ok(new Date(stored.updatedAt) > new Date(conversation.updatedAt));
        assert.strictEqual(stored.conversationName, "ບໍລິສັດ ກາເຟລາວ");
      } finally {
        world.restore();
      }
    });
  }

  await t.test("SEND is asked once a minute per member: the answer is cached 60 s", async () => {
    const conversation = orgConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      for (const text of ["one", "two", "three"]) {
        const res = await request(port, "POST", `/v1/api/organizations/conversations/${conversation._id}/messages`, { as: MEMBER, body: { body: text } });
        assert.strictEqual(res.status, 201);
      }
      assert.strictEqual(world.backend.authorizations().length, 1);
      assert.deepStrictEqual([...cached.keys()], [`orgchat:auth:${ORG}:${MEMBER}`]);
      assert.strictEqual([...cached.values()][0].ttlSeconds, 60);
    } finally {
      world.restore();
    }
  });

  await t.test("refused for a stranger (404, as for a missing id), an empty text, and with the backend unreachable (503)", async () => {
    const conversation = orgConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const url = `/v1/api/organizations/conversations/${conversation._id}/messages`;
      assert.strictEqual((await request(port, "POST", url, { as: STRANGER, body: { body: "hi" } })).status, 404);
      const empty = await request(port, "POST", url, { as: MEMBER, body: { body: "  " } });
      assert.strictEqual(empty.status, 400);
      assert.strictEqual(empty.body.errors.code, "VALIDATION_ERROR");
      assert.strictEqual(world.db.messages.length, 0);
    } finally {
      world.restore();
    }

    const down = setup({
      seed: { conversations: [orgConversation()] },
      authorize: () => {
        throw new Error("timeout of 2000ms exceeded");
      },
    });
    try {
      const id = down.db.conversations[0]._id;
      const res = await request(port, "POST", `/v1/api/organizations/conversations/${id}/messages`, { as: MEMBER, body: { body: "hi" } });
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.errors.code, "ORG_CHAT_UNAVAILABLE");
      assert.strictEqual(down.db.messages.length, 0);
    } finally {
      down.restore();
    }
  });
});

test("the candidate's reply reaches the company: SEND_MESSAGE and an ORGANIZATION push", async () => {
  const conversation = orgConversation();
  const world = setup({ seed: { conversations: [conversation] } });
  try {
    const res = await request(port, "POST", "/v1/api/messages", { as: CANDIDATE, body: { conversationId: conversation._id, body: "Next Monday" } });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data.sendAsOrganizationId, undefined);

    const [notice] = published.filter((p) => p.channel === "SEND_MESSAGE").map((p) => p.message);
    assert.strictEqual(notice.conversation.organizationId, ORG, "config/redis delivers it to org:{orgId} too");

    await settle();
    const [push] = world.backend.pushes();
    const { messageId, ...body } = push;
    assert.deepStrictEqual(body, {
      conversationId: conversation._id,
      senderId: CANDIDATE,
      recipientIds: [],
      messageType: "TEXT",
      snippet: "Next Monday",
      conversationType: "PRIVATE",
      organizationId: ORG,
      audience: "ORGANIZATION",
    });
    assert.strictEqual(world.db.conversations[0].latestMessageData.senderId, CANDIDATE);
  } finally {
    world.restore();
  }
});

test("POST /messages without sendAsOrganizationId: only into a conversation the caller is in", async () => {
  const conversation = orgConversation();
  const world = setup({ seed: { conversations: [conversation] } });
  try {
    // A member is not a participant; neither is a stranger.
    for (const as of [MEMBER, STRANGER]) {
      const res = await request(port, "POST", "/v1/api/messages", { as, body: { conversationId: conversation._id, body: "hi" } });
      assert.strictEqual(res.status, 404);
    }
    assert.strictEqual(world.db.messages.length, 0);
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------- list / messages

test("GET /organizations/:id/conversations: the inbox", async (t) => {
  await t.test("each with `unread` for the company, newest first, the candidate without their email", async () => {
    const fromCandidate = orgConversation({
      latestMessageData: { senderId: CANDIDATE, messageId: oid(), sendAt: new Date(Date.now() - 1000), readAllAt: null, isDeleted: false },
      updatedAt: new Date(Date.now() - 1000),
    });
    const readByCompany = orgConversation({
      candidateUserId: oid(),
      latestMessageData: { senderId: "x", messageId: oid(), sendAt: new Date(Date.now() - 5000), isDeleted: false },
      updatedAt: new Date(Date.now() - 5000),
    });
    readByCompany.latestMessageData.senderId = readByCompany.candidateUserId;
    readByCompany.orgSide = { lastReadAt: new Date(Date.now() - 4000) };
    const companyLast = orgConversation({ candidateUserId: oid(), updatedAt: new Date(Date.now() - 9000) });
    const otherOrg = orgConversation({ organizationId: oid(), candidateUserId: oid() });
    const world = setup({ seed: { conversations: [companyLast, readByCompany, fromCandidate, otherOrg] } });
    try {
      const res = await request(port, "GET", `/v1/api/organizations/${ORG}/conversations`, { as: MEMBER });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(
        res.body.data.conversations.map((c) => [c._id, c.unread]),
        [
          [fromCandidate._id, true],
          [readByCompany._id, false],
          [companyLast._id, false],
        ]
      );
      const populate = world.calls.populate.find(([pathName]) => pathName === "participants.user");
      assert.ok(populate, "the candidate is populated");
      assert.ok(!populate[1].split(" ").includes("email"), "never the email");
      assert.deepStrictEqual(world.backend.authorizations(), [{ action: "LIST", organizationId: ORG, actorUserId: MEMBER }]);
    } finally {
      world.restore();
    }
  });

  await t.test("refused with the backend's code for whoever may not LIST", async () => {
    const world = setup();
    try {
      const res = await request(port, "GET", `/v1/api/organizations/${ORG}/conversations`, { as: STRANGER });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.errors.code, "ORG_CHAT_NOT_MEMBER");
    } finally {
      world.restore();
    }
  });
});

test("GET /organizations/conversations/:id/messages: the company's view, newest first", async () => {
  const conversation = orgConversation();
  const t0 = Date.now() - 100_000;
  const messages = [0, 1, 2, 3].map((n) => ({
    _id: oid(),
    conversation: conversation._id,
    sender: n % 2 ? CANDIDATE : MEMBER,
    content: `m${n}`,
    messageType: "TEXT",
    createdAt: new Date(t0 + n * 1000),
    sendAt: new Date(t0 + n * 1000),
  }));
  const world = setup({ seed: { conversations: [conversation], messages } });
  try {
    const url = `/v1/api/organizations/conversations/${conversation._id}/messages`;
    const all = await request(port, "GET", url, { as: MEMBER });
    assert.strictEqual(all.status, 200);
    assert.deepStrictEqual(all.body.data.messages.map((m) => m.content), ["m3", "m2", "m1", "m0"]);

    const page = await request(port, "GET", `${url}?limit=2&skip=1`, { as: MEMBER });
    assert.deepStrictEqual(page.body.data.messages.map((m) => m.content), ["m2", "m1"]);

    const byId = await request(port, "GET", `${url}?before=${messages[2]._id}`, { as: MEMBER });
    assert.deepStrictEqual(byId.body.data.messages.map((m) => m.content), ["m1", "m0"]);
    const byTime = await request(port, "GET", `${url}?before=${new Date(t0 + 1500).toISOString()}&limit=1`, { as: MEMBER });
    assert.deepStrictEqual(byTime.body.data.messages.map((m) => m.content), ["m1"]);

    assert.strictEqual((await request(port, "GET", url, { as: STRANGER })).status, 404);
    assert.strictEqual((await request(port, "GET", `/v1/api/organizations/conversations/${oid()}/messages`, { as: MEMBER })).status, 404);
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------- org read

test("PUT /organizations/conversations/:id/read: the company read", async (t) => {
  await t.test("moves orgSide forward without reordering; the candidate's latest becomes read by all; READ_MESSAGE to the candidate only", async () => {
    const sendAt = new Date(Date.now() - 30_000);
    const latestId = oid();
    const conversation = orgConversation({
      latestMessageData: { senderId: CANDIDATE, messageId: latestId, messageType: "TEXT", content: "Next Monday", sendAt, readAllAt: null, isDeleted: false },
    });
    const messages = [
      { _id: oid(), conversation: conversation._id, sender: MEMBER, sendAsOrganizationId: ORG, sendAt: new Date(sendAt.getTime() - 1000), readAllAt: null },
      { _id: latestId, conversation: conversation._id, sender: CANDIDATE, sendAt, readAllAt: null },
    ];
    const world = setup({ seed: { conversations: [conversation], messages } });
    try {
      const res = await request(port, "PUT", `/v1/api/organizations/conversations/${conversation._id}/read`, { as: MEMBER });
      assert.strictEqual(res.status, 200);
      const { conversationId, lastReadAt, readAllAt } = res.body.data;
      assert.strictEqual(conversationId, conversation._id);
      assert.ok(lastReadAt && readAllAt);

      const stored = world.db.conversations[0];
      assert.strictEqual(new Date(stored.orgSide.lastReadAt).toISOString(), lastReadAt);
      assert.strictEqual(stored.orgSide.lastReadBy, MEMBER);
      assert.ok(stored.orgSide.lastDeliveredAt);
      assert.strictEqual(new Date(stored.latestMessageData.readAllAt).toISOString(), readAllAt);
      assert.strictEqual(new Date(stored.updatedAt).getTime(), conversation.updatedAt.getTime(), "a read never moves the chat up");
      assert.ok(world.calls.writes.filter((w) => w.collection === "conversations").every((w) => w.options.timestamps === false));
      // The candidate's message is read by all; the company's own is left alone.
      assert.deepStrictEqual(world.db.messages.map((m) => Boolean(m.readAllAt)), [false, true]);

      const reads = published.filter((p) => p.channel === "READ_MESSAGE").map((p) => p.message);
      assert.deepStrictEqual(reads, [{ userIds: [CANDIDATE], conversationId: conversation._id, readerId: MEMBER, readAt: lastReadAt, readAllAt }]);

      // Again: nothing new to tell anyone.
      published.length = 0;
      assert.strictEqual((await request(port, "PUT", `/v1/api/organizations/conversations/${conversation._id}/read`, { as: OTHER_MEMBER })).status, 200);
      assert.deepStrictEqual(published.filter((p) => p.channel === "READ_MESSAGE"), []);
      assert.strictEqual(world.db.conversations[0].orgSide.lastReadBy, OTHER_MEMBER);

      // The inbox no longer shows it unread.
      const list = await request(port, "GET", `/v1/api/organizations/${ORG}/conversations`, { as: MEMBER });
      assert.strictEqual(list.body.data.conversations[0].unread, false);
    } finally {
      world.restore();
    }
  });

  await t.test("the company's own latest message: read state moves, the candidate hears nothing", async () => {
    const conversation = orgConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const res = await request(port, "PUT", `/v1/api/organizations/conversations/${conversation._id}/read`, { as: MEMBER });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.readAllAt, null);
      assert.deepStrictEqual(published.filter((p) => p.channel === "READ_MESSAGE"), []);
      assert.strictEqual((await request(port, "PUT", `/v1/api/organizations/conversations/${conversation._id}/read`, { as: STRANGER })).status, 404);
    } finally {
      world.restore();
    }
  });
});

test("the candidate's own read of a company conversation also reaches the company room", async () => {
  const conversation = orgConversation();
  const world = setup({ seed: { conversations: [conversation] } });
  try {
    const res = await request(port, "PUT", `/v1/api/message-status/read?conversationId=${conversation._id}`, { as: CANDIDATE });
    assert.strictEqual(res.status, 200);
    const [read] = published.filter((p) => p.channel === "READ_MESSAGE").map((p) => p.message);
    assert.deepStrictEqual(read.userIds, [CANDIDATE]);
    assert.strictEqual(read.orgRoom, `org:${ORG}`);
    assert.strictEqual(read.readerId, CANDIDATE);
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------- mute

test("PUT /conversations/:id/mute: a muted conversation gets no push", async () => {
  const conversation = orgConversation();
  const world = setup({ seed: { conversations: [conversation] } });
  try {
    const mute = (muted, as = CANDIDATE) => request(port, "PUT", `/v1/api/conversations/${conversation._id}/mute`, { as, body: { muted } });
    const companySend = (text) =>
      request(port, "POST", `/v1/api/organizations/conversations/${conversation._id}/messages`, { as: MEMBER, body: { body: text } });

    const res = await mute(true);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.data, { conversationId: conversation._id, muted: true });
    assert.strictEqual(world.db.conversations[0].participants[0].isMuted, true);
    assert.strictEqual(new Date(world.db.conversations[0].updatedAt).getTime(), conversation.updatedAt.getTime(), "muting never reorders");

    assert.strictEqual((await companySend("muted?")).status, 201);
    await settle();
    assert.deepStrictEqual(world.backend.pushes(), [], "no push while muted");
    assert.strictEqual(published.filter((p) => p.channel === "SEND_MESSAGE").length, 1, "the message itself still goes to the sockets");

    assert.strictEqual((await mute(false)).status, 200);
    await companySend("unmuted");
    await settle();
    assert.strictEqual(world.backend.pushes().length, 1);

    assert.strictEqual((await mute("yes")).status, 400);
    assert.strictEqual((await mute(true, MEMBER)).status, 404, "a member is not a participant");
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------- block

test("POST /conversations/:id/block: the candidate blocks the company for good", async (t) => {
  await t.test("idempotent; the backend is told; then nobody can send or reopen", async () => {
    const conversation = orgConversation();
    const world = setup({ seed: { conversations: [conversation] } });
    try {
      const block = () => request(port, "POST", `/v1/api/conversations/${conversation._id}/block`, { as: CANDIDATE });
      const first = await block();
      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.body.data.conversationId, conversation._id);
      const { blockedAt } = first.body.data;
      assert.ok(blockedAt);
      const second = await block();
      assert.deepStrictEqual(second.body.data, { conversationId: conversation._id, blockedAt });
      assert.deepStrictEqual(world.backend.blocks(), [
        { userId: CANDIDATE, organizationId: ORG, conversationId: conversation._id },
        { userId: CANDIDATE, organizationId: ORG, conversationId: conversation._id },
      ]);
      assert.strictEqual(new Date(world.db.conversations[0].updatedAt).getTime(), conversation.updatedAt.getTime());

      const companySend = await request(port, "POST", `/v1/api/organizations/conversations/${conversation._id}/messages`, { as: MEMBER, body: { body: "hello?" } });
      assert.strictEqual(companySend.status, 403);
      assert.strictEqual(companySend.body.errors.code, "ORG_CHAT_BLOCKED");
      const sendAs = await request(port, "POST", "/v1/api/messages", { as: MEMBER, body: { conversationId: conversation._id, sendAsOrganizationId: ORG, body: "hello?" } });
      assert.strictEqual(sendAs.status, 403);
      const reply = await request(port, "POST", "/v1/api/messages", { as: CANDIDATE, body: { conversationId: conversation._id, body: "bye" } });
      assert.strictEqual(reply.status, 403);
      assert.strictEqual(reply.body.errors.code, "ORG_CHAT_BLOCKED");
      const reopen = await open(port);
      assert.strictEqual(reopen.status, 403);
      assert.strictEqual(reopen.body.errors.code, "ORG_CHAT_BLOCKED");
      assert.strictEqual(world.db.messages.length, 0);

      // The candidate can still read the history; the company can still list it, with the block.
      assert.strictEqual((await request(port, "GET", `/v1/api/messages?conversationId=${conversation._id}`, { as: CANDIDATE })).status, 200);
      const list = await request(port, "GET", `/v1/api/organizations/${ORG}/conversations`, { as: MEMBER });
      assert.ok(list.body.data.conversations[0].candidateBlockedAt);
    } finally {
      world.restore();
    }
  });

  await t.test("the candidate only, company conversations only; a backend that is down does not undo it", async () => {
    const conversation = orgConversation();
    const privateChat = { _id: oid(), conversationType: "PRIVATE", participants: [{ user: CANDIDATE }, { user: STRANGER }], latestMessageData: {} };
    const world = setup({ seed: { conversations: [conversation, privateChat] } });
    try {
      assert.strictEqual((await request(port, "POST", `/v1/api/conversations/${conversation._id}/block`, { as: MEMBER })).status, 404);
      const notCompany = await request(port, "POST", `/v1/api/conversations/${privateChat._id}/block`, { as: CANDIDATE });
      assert.strictEqual(notCompany.status, 400);
      assert.strictEqual(notCompany.body.errors.code, "NOT_ORGANIZATION_CONVERSATION");
    } finally {
      world.restore();
    }

    const down = setup({ seed: { conversations: [orgConversation()] }, backend: { blocked: false } });
    try {
      const id = down.db.conversations[0]._id;
      const res = await request(port, "POST", `/v1/api/conversations/${id}/block`, { as: CANDIDATE });
      assert.strictEqual(res.status, 200);
      assert.ok(down.db.conversations[0].candidateBlockedAt);
    } finally {
      down.restore();
    }
  });
});

// ---------------------------------------------------------------- switched off

test("ORG_CHAT_ENABLED off", async (t) => {
  await t.test("open and the new routes answer 403 ORG_CHAT_DISABLED without asking the backend", async () => {
    const conversation = orgConversation();
    const world = setup({ enabled: "false", seed: { conversations: [conversation] } });
    try {
      for (const [method, url, as, body] of [
        ["POST", `/v1/api/organizations/${ORG}/conversations`, MEMBER, openBody()],
        ["GET", `/v1/api/organizations/conversations/${conversation._id}/messages`, MEMBER],
        ["PUT", `/v1/api/organizations/conversations/${conversation._id}/read`, MEMBER],
        ["PUT", `/v1/api/conversations/${conversation._id}/mute`, CANDIDATE, { muted: true }],
        ["POST", `/v1/api/conversations/${conversation._id}/block`, CANDIDATE],
      ]) {
        const res = await request(port, method, url, { as, body });
        assert.strictEqual(res.status, 403, url);
        assert.strictEqual(res.body.errors.code, "ORG_CHAT_DISABLED", url);
      }
      assert.deepStrictEqual(world.backend.calls, []);
      assert.strictEqual(world.db.messages.length, 0);
    } finally {
      world.restore();
    }
  });

  await t.test("the routes that existed keep their rule (an ACTIVE membership), with no fan-out and no push", async () => {
    const conversation = orgConversation();
    const world = setup({ enabled: "false", seed: { conversations: [conversation] } });
    const members = stub(mongoose.models.OrganizationMember, "findOne", (filter) => query(filter.userId === MEMBER ? { status: "ACTIVE" } : null));
    try {
      const list = await request(port, "GET", `/v1/api/organizations/${ORG}/conversations`, { as: MEMBER });
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.body.data.conversations.length, 1);
      assert.strictEqual((await request(port, "GET", `/v1/api/organizations/${ORG}/conversations`, { as: STRANGER })).body.errors.code, "ORGANIZATION_MEMBERSHIP_REQUIRED");

      const sent = await request(port, "POST", `/v1/api/organizations/conversations/${conversation._id}/messages`, { as: MEMBER, body: { body: "hi" } });
      assert.strictEqual(sent.status, 201);
      const reply = await request(port, "POST", "/v1/api/messages", { as: CANDIDATE, body: { conversationId: conversation._id, body: "hello" } });
      assert.strictEqual(reply.status, 201);
      await settle();
      assert.deepStrictEqual(world.backend.calls, []);
      assert.deepStrictEqual(published.filter((p) => p.channel === "SEND_MESSAGE"), []);
    } finally {
      members();
      world.restore();
    }
  });
});

// ---------------------------------------------------------------- .save()

test(".save() is never used on conversations (CHAT-CONTRACT.md §1.1)", () => {
  // Every flow above ran with conversationModel.prototype.save failing the
  // test (tests/helpers/org-chat-fakes.js). The source says the same.
  for (const file of ["routes/organization.js", "routes/message.js", "services/org-chat.js", "controllers/conversation/candidate.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "../dist", file), "utf8");
    assert.doesNotMatch(source, /\.save\(/, file);
  }
});
