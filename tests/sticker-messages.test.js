/**
 * STICKER messages (worktrees/STICKER-CONTRACT.md §4) everywhere but the
 * socket handler, which socket-auth.test.js covers. Against the compiled
 * dist/ with no Redis and no Mongo (tests/helpers/offline.js): npm test
 *
 * - checkSticker, the one rule every send path runs;
 * - STICKER_URL_PREFIX: its default, and a bad value stopping the boot;
 * - the two REST sends: refuse a bad sticker before reading anything, store a
 *   good one as a STICKER;
 * - latestMessageData.messageType, written by every path that writes
 *   latestMessageData, so the list can say "Sticker".
 */
const { stub, query } = require("./helpers/offline");

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { Types } = mongoose;

const { env } = require("../dist/config/env.js");
const router = require("../dist/routes/index.js").default;
const { checkSticker } = require("../dist/utils/sticker.js");
const { conversationModel } = require("../dist/models/conversation.js");
const { messageModel } = require("../dist/models/message.js");
const { messageStatusModel } = require("../dist/models/messageStatus.js");
const { sendPrivateMessage, sendGroupMessage } = require("../dist/controllers/message/index.js");

const PREFIX = "https://seemuehub-storage.s3.ap-southeast-1.amazonaws.com/images/";
const oid = () => new Types.ObjectId().toString();
const tokenFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET_KEY, { expiresIn: "1h" });
const sticker = (fileName = oid()) => ({ fileName, fileUrl: `${PREFIX}${fileName}.webp` });

const app = express();
app.use(express.json());
app.use("/v1/api", router);

const listen = () => new Promise((resolve) => { const server = app.listen(0, () => resolve(server)); });
const post = (port, url, { token, body }) =>
  new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        port,
        path: url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
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
    req.write(payload);
    req.end();
  });

// ---------------------------------------------------------------- the rule

test("checkSticker", async (t) => {
  await t.test("a valid sticker passes, with content STICKER and only fileName and fileUrl kept", () => {
    const { fileName, fileUrl } = sticker();
    assert.deepStrictEqual(checkSticker([{ fileName, fileUrl, originalName: "x", fileSize: "1" }], PREFIX), {
      ok: true,
      content: "STICKER",
      attachments: [{ fileName, fileUrl }],
    });
  });

  await t.test("the prefix is the one passed in", () => {
    const fileName = oid();
    assert.strictEqual(checkSticker([{ fileName, fileUrl: `https://cdn.test/s/${fileName}.png` }], "https://cdn.test/s/").ok, true);
    assert.strictEqual(checkSticker([sticker()], "https://cdn.test/s/").ok, false);
  });

  await t.test("each refusal says why", () => {
    assert.deepStrictEqual(checkSticker(undefined, PREFIX), { ok: false, reason: "ATTACHMENT_COUNT" });
    assert.deepStrictEqual(checkSticker([sticker(), sticker()], PREFIX), { ok: false, reason: "ATTACHMENT_COUNT" });
    assert.deepStrictEqual(checkSticker([{ ...sticker(), fileUrl: "https://example.com/a.png" }], PREFIX), { ok: false, reason: "FILE_URL" });
    assert.deepStrictEqual(checkSticker([{ ...sticker(), fileName: "a.png" }], PREFIX), { ok: false, reason: "FILE_NAME" });
  });

  await t.test("a path that a browser resolves out of the prefix is refused", () => {
    for (const tail of ["../private/a.png", "%2e%2e/private/a.png", ".%2E/private/a.png", "..\\private\\a.png", "a/../../private/a.png"]) {
      assert.deepStrictEqual(checkSticker([{ fileName: oid(), fileUrl: `${PREFIX}${tail}` }], PREFIX), { ok: false, reason: "FILE_URL" }, tail);
    }
  });

  await t.test("a path that stays inside the prefix after resolving is fine", () => {
    assert.strictEqual(checkSticker([{ fileName: oid(), fileUrl: `${PREFIX}packs/../a.png` }], PREFIX).ok, true);
  });
});

// ---------------------------------------------------------------- STICKER_URL_PREFIX

test("STICKER_URL_PREFIX", async (t) => {
  await t.test("defaults to production's images/ prefix", () => {
    assert.strictEqual(env.STICKER_URL_PREFIX, PREFIX);
  });

  /** Loads config/env in a fresh process with STICKER_URL_PREFIX set to `value`. */
  const boot = (value) =>
    spawnSync(process.execPath, ["-e", "console.log(require('./dist/config/env.js').env.STICKER_URL_PREFIX)"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, STICKER_URL_PREFIX: value },
      encoding: "utf8",
    });

  await t.test("a set value is used, trimmed", () => {
    const result = boot("  https://cdn.example.com/stickers/  ");
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), "https://cdn.example.com/stickers/");
  });

  await t.test("an empty value is the default", () => {
    const result = boot("");
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), PREFIX);
  });

  for (const bad of ["https://seemuehub-storage.s3.ap-southeast-1.amazonaws.com", "http://cdn.example.com/stickers/", "not a url"]) {
    await t.test(`${JSON.stringify(bad)} stops the boot`, () => {
      const result = boot(bad);
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /STICKER_URL_PREFIX/);
    });
  }
});

// ---------------------------------------------------------------- REST sends

test("REST sends: STICKER", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const me = oid();
  const organizationId = oid();
  const token = tokenFor(me);

  const lookups = [];
  const created = [];
  /**
   * The conversation each request finds; its latestMessageData is what the
   * handler wrote. Both routes write it with an update, never .save()
   * (CHAT-CONTRACT.md §1.1), which is applied here.
   */
  let conversation;
  const find = (filter) => {
    lookups.push(filter);
    conversation = { _id: (filter && filter._id) || filter, organizationId: new Types.ObjectId(organizationId) };
    return query(conversation);
  };
  const restores = [
    stub(conversationModel, "findById", find),
    stub(conversationModel, "findOne", find),
    stub(conversationModel, "findOneAndUpdate", (filter, update) => {
      Object.assign(conversation, update.$set);
      return query(conversation);
    }),
    stub(messageModel, "create", async (doc) => {
      created.push(doc);
      return { _id: new Types.ObjectId(), sendAt: new Date(), ...doc };
    }),
    // Both routes look up an ACTIVE membership for an organization send
    // while ORG_CHAT_ENABLED is off, as they always did.
    stub(mongoose.models.OrganizationMember, "findOne", () => query({ status: "ACTIVE" })),
  ];

  const routes = [
    ["POST /messages", () => ["/v1/api/messages", { conversationId: oid(), sendAsOrganizationId: organizationId }]],
    ["POST /organizations/conversations/:id/messages", () => [`/v1/api/organizations/conversations/${oid()}/messages`, {}]],
  ];
  for (const [label, target] of routes) {
    await t.test(`${label}: a bad sticker is a 400 before anything is read`, async () => {
      for (const attachments of [undefined, [], [sticker(), sticker()], [{ fileName: oid(), fileUrl: "https://example.com/a.png" }], [{ fileName: "a", fileUrl: `${PREFIX}a.png` }]]) {
        lookups.length = 0;
        created.length = 0;
        const [url, base] = target();
        const res = await post(port, url, { token, body: { ...base, messageType: "STICKER", content: "STICKER", attachments } });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.body, { code: "CHAT-400", message: "Invalid sticker" });
        assert.deepStrictEqual(lookups, []);
        assert.deepStrictEqual(created, []);
      }
    });

    await t.test(`${label}: a good sticker is stored as a STICKER, and the list learns its type`, async () => {
      created.length = 0;
      const [url, base] = target();
      const { fileName, fileUrl } = sticker();
      const res = await post(port, url, {
        token,
        body: { ...base, messageType: "STICKER", body: "not a sticker", attachments: [{ fileName, fileUrl, originalName: "x" }] },
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(created.length, 1);
      assert.strictEqual(created[0].messageType, "STICKER");
      assert.strictEqual(created[0].content, "STICKER");
      assert.deepStrictEqual(created[0].attachments, [{ fileName, fileUrl }]);
      assert.strictEqual(created[0].fileUploaded, true);
      assert.strictEqual(conversation.latestMessageData.messageType, "STICKER");
      assert.strictEqual(conversation.latestMessageData.content, "STICKER");
    });

    await t.test(`${label}: anything else is still stored as TEXT, now with messageType in latestMessageData`, async () => {
      created.length = 0;
      const [url, base] = target();
      const res = await post(port, url, { token, body: { ...base, body: "hello", attachments: [sticker()] } });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(created[0].messageType, "TEXT");
      assert.strictEqual(created[0].content, "hello");
      assert.ok(!("attachments" in created[0]), "a TEXT send stores no attachments, as before");
      assert.strictEqual(conversation.latestMessageData.messageType, "TEXT");
    });
  }

  for (const restore of restores) restore();
  server.close();
});

// ---------------------------------------------------------------- latestMessageData.messageType

test("latestMessageData.messageType", async (t) => {
  await t.test("the conversation schema keeps it (an unknown path would be dropped)", () => {
    const doc = new conversationModel({ latestMessageData: { messageType: "STICKER", isDeleted: false } });
    assert.strictEqual(doc.latestMessageData.messageType, "STICKER");
  });

  const session = { startTransaction() {}, commitTransaction: async () => {}, abortTransaction: async () => {}, endSession() {} };
  const updates = [];
  const errors = [];
  const socket = { emit: (event, payload) => errors.push({ event, payload }) };
  const restores = [
    stub(mongoose, "startSession", async () => session),
    stub(messageModel, "create", async (docs) => docs.map((doc) => ({ ...doc }))),
    stub(conversationModel, "findByIdAndUpdate", async (id, update) => {
      updates.push(update);
      return { _id: id, participants: [] };
    }),
    stub(messageStatusModel, "insertMany", async () => []),
  ];

  for (const [label, send] of [["NEW_MESSAGE (sendPrivateMessage)", sendPrivateMessage], ["NEW_GROUP_MESSAGE (sendGroupMessage)", sendGroupMessage]]) {
    for (const messageType of ["STICKER", "TEXT", "IMAGE"]) {
      await t.test(`${label} writes the stored ${messageType}'s type`, async () => {
        updates.length = 0;
        errors.length = 0;
        const content = messageType === "STICKER" ? "STICKER" : "hello";
        await send(socket, null, { messageType, content, conversationId: oid(), senderId: oid(), receiverId: oid(), attachments: [sticker()] });
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(updates.length, 1);
        assert.strictEqual(updates[0].latestMessageData.messageType, messageType);
        assert.strictEqual(updates[0].latestMessageData.content, content);
      });
    }
  }

  await t.test("POST /orders (an order event) writes TEXT next to its orderStep", async () => {
    updates.length = 0;
    const restoreKey = (() => {
      const previous = env.CHAT_INTERNAL_KEY;
      env.CHAT_INTERNAL_KEY = undefined;
      return () => (env.CHAT_INTERNAL_KEY = previous);
    })();
    const restoreCreate = stub(messageModel, "create", async (doc) => ({ _id: new Types.ObjectId(), ...doc }));
    const server = await listen();
    const res = await post(server.address().port, "/v1/api/orders", {
      body: { _id: oid(), orderId: oid(), orderSender: oid(), participants: [], latestMessageData: { orderStep: "CANCELLED" } },
    });
    server.close();
    restoreCreate();
    restoreKey();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].latestMessageData.messageType, "TEXT");
    assert.strictEqual(updates[0].latestMessageData.orderStep, "CANCELLED");
  });

  for (const restore of restores) restore();
});
