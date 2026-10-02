/**
 * Replies (worktrees/CHAT-CONTRACT.md §2), against the compiled dist/ with no
 * Redis and no Mongo (tests/helpers/offline.js): npm test
 *
 * - replyDropReason / buildReplyPreview (utils/reply.ts), the pure rules;
 * - the Message schema keeps replyPreview and reactions, and stores neither
 *   on a message that has none;
 * - sendPrivateMessage / sendGroupMessage: a valid replyTo becomes isReply +
 *   a server-built replyPreview; an invalid one is dropped (logged
 *   reply_dropped) and the message is delivered anyway;
 * - the socket strips a forged replyPreview / reactions and keeps replyTo.
 */
const { published, stub, query } = require("./helpers/offline");

const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");
const { Types } = mongoose;

const { conversationModel } = require("../dist/models/conversation.js");
const { messageModel } = require("../dist/models/message.js");
const { messageStatusModel } = require("../dist/models/messageStatus.js");
const { sendPrivateMessage, sendGroupMessage } = require("../dist/controllers/message/index.js");
const { replyDropReason, buildReplyPreview, clipText, REPLY_TEXT_MAX } = require("../dist/utils/reply.js");
const harness = require("./helpers/socket-harness");
const { logged, oid } = harness;

const STICKER_URL = `${harness.STICKER_PREFIX}stickers/${oid()}.webp`;

/** A stored message as Mongo holds it. */
const stored = (extra = {}) => ({
  _id: new Types.ObjectId(),
  conversation: new Types.ObjectId(),
  sender: new Types.ObjectId(),
  messageType: "TEXT",
  content: "hello",
  attachments: [],
  isDeleted: false,
  isOrderMessage: false,
  ...extra,
});

// ---------------------------------------------------------------- the rules

test("replyDropReason", async (t) => {
  const conversationId = new Types.ObjectId();
  const target = stored({ conversation: conversationId });

  await t.test("a target in the same conversation, not deleted, not an order message: no reason", () => {
    assert.strictEqual(replyDropReason(String(target._id), target, conversationId), null);
    assert.strictEqual(replyDropReason(String(target._id), target, String(conversationId)), null, "string or ObjectId alike");
  });

  const cases = [
    ["not an ObjectId", "nope", target, "INVALID_ID"],
    ["a number", 42, target, "INVALID_ID"],
    ["an object", { $ne: null }, target, "INVALID_ID"],
    ["no such message", String(target._id), null, "NOT_FOUND"],
    ["another conversation", String(target._id), { ...target, conversation: new Types.ObjectId() }, "OTHER_CONVERSATION"],
    ["a message with no conversation", String(target._id), { ...target, conversation: undefined }, "OTHER_CONVERSATION"],
    ["a deleted message", String(target._id), { ...target, isDeleted: true }, "DELETED"],
    ["an order message", String(target._id), { ...target, isOrderMessage: true }, "ORDER_MESSAGE"],
  ];
  for (const [label, replyTo, candidate, reason] of cases) {
    await t.test(`${label}: ${reason}`, () => {
      assert.strictEqual(replyDropReason(replyTo, candidate, conversationId), reason);
    });
  }
});

test("buildReplyPreview", async (t) => {
  await t.test("TEXT: the content, with the target's id, sender and type", () => {
    const target = stored({ content: "see you at noon" });
    assert.deepStrictEqual(buildReplyPreview(target), {
      messageId: target._id,
      senderId: String(target.sender),
      messageType: "TEXT",
      text: "see you at noon",
    });
  });

  await t.test("TEXT: clipped to 160 UTF-16 units, never inside a character", () => {
    assert.strictEqual(buildReplyPreview(stored({ content: "a".repeat(400) })).text, "a".repeat(REPLY_TEXT_MAX));
    // 159 letters then an emoji (2 units): the emoji would cross 160, so it goes.
    assert.strictEqual(buildReplyPreview(stored({ content: `${"a".repeat(159)}😂😂` })).text, "a".repeat(159));
    // Lao: a consonant and its vowel sign are one character on screen; never split.
    const lao = "ກິ".repeat(100); // 200 units, 100 graphemes of 2
    const clipped = buildReplyPreview(stored({ content: lao })).text;
    assert.strictEqual(clipped, "ກິ".repeat(80));
    assert.ok(clipped.length <= REPLY_TEXT_MAX);
    assert.strictEqual(clipText("short", 160), "short");
  });

  await t.test("FILE: originalName, else fileName; no text", () => {
    const withOriginal = stored({ messageType: "FILE", content: "x", attachments: [{ fileName: "abc.pdf", fileUrl: "https://x/abc.pdf", originalName: "Contract.pdf" }] });
    assert.deepStrictEqual(
      { text: buildReplyPreview(withOriginal).text, fileName: buildReplyPreview(withOriginal).fileName, thumbUrl: buildReplyPreview(withOriginal).thumbUrl },
      { text: "", fileName: "Contract.pdf", thumbUrl: undefined }
    );
    const withoutOriginal = stored({ messageType: "FILE", attachments: [{ fileName: "abc.pdf", fileUrl: "https://x/abc.pdf", originalName: "" }] });
    assert.strictEqual(buildReplyPreview(withoutOriginal).fileName, "abc.pdf");
    assert.ok(!("fileName" in buildReplyPreview(stored({ messageType: "FILE", attachments: [] }))));
  });

  await t.test("IMAGE: the first attachment's fileUrl as thumbUrl; no text", () => {
    const preview = buildReplyPreview(stored({ messageType: "IMAGE", content: "a caption", attachments: [{ fileUrl: "https://x/1.jpg" }, { fileUrl: "https://x/2.jpg" }] }));
    assert.strictEqual(preview.thumbUrl, "https://x/1.jpg");
    assert.strictEqual(preview.text, "");
  });

  await t.test("STICKER: the sticker's url (its attachment; the stored content is the literal STICKER)", () => {
    const preview = buildReplyPreview(stored({ messageType: "STICKER", content: "STICKER", attachments: [{ fileName: oid(), fileUrl: STICKER_URL }] }));
    assert.deepStrictEqual({ text: preview.text, thumbUrl: preview.thumbUrl }, { text: "", thumbUrl: STICKER_URL });
    // A sticker stored with its url in content (the contract's wording) still gets one.
    assert.strictEqual(buildReplyPreview(stored({ messageType: "STICKER", content: STICKER_URL, attachments: [] })).thumbUrl, STICKER_URL);
    assert.ok(!("thumbUrl" in buildReplyPreview(stored({ messageType: "STICKER", content: "STICKER", attachments: [] }))));
  });

  for (const messageType of ["VOICE", "VIDEO", "LOCATION"]) {
    await t.test(`${messageType}: just the type, text ""`, () => {
      const preview = buildReplyPreview(stored({ messageType, content: "https://x/a.m4a", attachments: [{ fileUrl: "https://x/a.m4a", originalName: "a.m4a" }] }));
      assert.deepStrictEqual(
        { text: preview.text, fileName: preview.fileName, thumbUrl: preview.thumbUrl, messageType: preview.messageType },
        { text: "", fileName: undefined, thumbUrl: undefined, messageType }
      );
    });
  }
});

// ---------------------------------------------------------------- the schema

test("Message schema: replyPreview and reactions", async (t) => {
  await t.test("kept when set", () => {
    const messageId = new Types.ObjectId();
    const user = new Types.ObjectId();
    const at = new Date("2026-10-02T01:00:00.000Z");
    const doc = new messageModel({
      messageType: "TEXT",
      content: "yes",
      isReply: true,
      replyTo: messageId,
      replyPreview: { messageId, senderId: String(user), messageType: "IMAGE", text: "", thumbUrl: "https://x/1.jpg" },
      reactions: [{ user, emoji: "❤️", at }],
    });
    const json = doc.toJSON();
    assert.deepStrictEqual(json.replyPreview, { messageId, senderId: String(user), messageType: "IMAGE", text: "", thumbUrl: "https://x/1.jpg" });
    assert.deepStrictEqual(json.reactions, [{ user, emoji: "❤️", at }], "no _id per reaction");
    assert.strictEqual(doc.validateSync(), undefined);
  });

  await t.test("absent on a message without them (no empty reactions array is stored)", () => {
    const json = new messageModel({ messageType: "TEXT", content: "hi" }).toJSON();
    assert.ok(!("replyPreview" in json));
    assert.ok(!("reactions" in json));
    assert.strictEqual(json.isReply, false);
  });
});

// ---------------------------------------------------------------- the sends

/** Captures the JSON log lines while `fn` runs. */
const quietly = async (fn) => {
  const saved = { log: console.log, error: console.error };
  const lines = [];
  console.log = (...args) => {
    try {
      lines.push(JSON.parse(args[0]));
    } catch {}
  };
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
  return lines;
};

/**
 * Stubs a send's session and writes. `targets` are the stored messages the
 * reply lookup can find; `created` gets what would be inserted, as the schema
 * casts it.
 */
const install = ({ conversation, targets = [] }) => {
  const created = [];
  const lookups = [];
  const session = {
    startTransaction() {},
    inTransaction: () => true,
    async commitTransaction() {},
    async abortTransaction() {},
    endSession() {},
  };
  const restores = [
    stub(mongoose, "startSession", async () => session),
    stub(messageModel, "findOne", (filter) => {
      lookups.push(filter);
      const found = targets.find((target) => String(target._id) === String(filter._id));
      return query(found ? { ...found } : null);
    }),
    stub(messageModel, "create", async (docs) => {
      const doc = new messageModel(docs[0]);
      created.push(doc.toJSON());
      return [doc];
    }),
    // createOrGetConversation (a private send without a conversationId) finds this one.
    stub(conversationModel, "findOne", () => query(conversation)),
    stub(conversationModel, "findByIdAndUpdate", async () => conversation),
    stub(messageStatusModel, "insertMany", async () => []),
  ];
  return { created, lookups, restore: () => restores.reverse().forEach((restore) => restore()) };
};

const SENDS = [
  ["NEW_MESSAGE (sendPrivateMessage)", sendPrivateMessage, "NEW_MESSAGE"],
  ["NEW_GROUP_MESSAGE (sendGroupMessage)", sendGroupMessage, "NEW_GROUP_MESSAGE"],
];

for (const [label, send, event] of SENDS) {
  test(`${label}: replyTo`, async (t) => {
    const sender = oid();
    const other = oid();
    const conversationId = new Types.ObjectId();
    const conversation = {
      _id: conversationId,
      conversationType: "PRIVATE",
      participants: [{ user: new Types.ObjectId(sender), isMuted: false }, { user: new Types.ObjectId(other), isMuted: false }],
    };
    const socket = { id: "socket-1", emit: () => assert.fail("no ERROR expected") };
    const payload = (extra = {}) => ({
      _id: oid(),
      messageType: "TEXT",
      content: "agreed",
      senderId: sender,
      receiverId: other,
      conversationId: String(conversationId),
      ...extra,
    });
    const run = async (targets, data) => {
      const db = install({ conversation, targets });
      published.length = 0;
      let lines;
      try {
        lines = await quietly(() => send(socket, null, data));
      } finally {
        db.restore();
      }
      return { ...db, lines, sent: published.filter((p) => p.channel === "SEND_MESSAGE").map((p) => p.message.messageData) };
    };

    await t.test("a valid target: isReply, replyTo and a server-built replyPreview, stored and delivered", async () => {
      const target = stored({ conversation: conversationId, sender: new Types.ObjectId(other), messageType: "IMAGE", content: "x", attachments: [{ fileUrl: "https://x/1.jpg" }] });
      const result = await run([target], payload({ replyTo: String(target._id) }));
      assert.strictEqual(result.lookups.length, 1);
      assert.strictEqual(String(result.lookups[0]._id), String(target._id));
      const [message] = result.created;
      assert.strictEqual(message.isReply, true);
      assert.strictEqual(String(message.replyTo), String(target._id));
      assert.deepStrictEqual(JSON.parse(JSON.stringify(message.replyPreview)), {
        messageId: String(target._id),
        senderId: other,
        messageType: "IMAGE",
        text: "",
        thumbUrl: "https://x/1.jpg",
      });
      assert.ok(!("reactions" in message));
      assert.strictEqual(result.sent.length, 1, "delivered on SEND_MESSAGE");
      assert.strictEqual(result.sent[0].replyPreview.thumbUrl, "https://x/1.jpg");
      assert.deepStrictEqual(result.lines.filter((l) => l.msg === "reply_dropped"), []);
    });

    const invalid = [
      ["in another conversation", () => stored({ conversation: new Types.ObjectId() }), "OTHER_CONVERSATION"],
      ["deleted", () => stored({ conversation: conversationId, isDeleted: true }), "DELETED"],
      ["an order message", () => stored({ conversation: conversationId, isOrderMessage: true, messageType: "ORDER_STATUS_CHANGE" }), "ORDER_MESSAGE"],
      ["missing", () => null, "NOT_FOUND"],
    ];
    for (const [what, make, reason] of invalid) {
      await t.test(`a target ${what}: the reply is dropped, the message still goes, reply_dropped ${reason}`, async () => {
        const target = make();
        const replyTo = target ? String(target._id) : oid();
        const result = await run(target ? [target] : [], payload({ replyTo, isReply: true }));
        const [message] = result.created;
        assert.strictEqual(message.isReply, false);
        assert.ok(!("replyTo" in message));
        assert.ok(!("replyPreview" in message));
        assert.strictEqual(message.content, "agreed");
        assert.strictEqual(result.sent.length, 1);
        assert.deepStrictEqual(
          result.lines.filter((l) => l.msg === "reply_dropped").map((l) => ({ event: l.event, reason: l.reason, userId: l.userId, replyTo: l.replyTo })),
          [{ event, reason, userId: sender, replyTo }]
        );
      });
    }

    await t.test("a replyTo that is not an id: dropped without a lookup", async () => {
      const result = await run([], payload({ replyTo: "not-an-id" }));
      assert.deepStrictEqual(result.lookups, []);
      assert.strictEqual(result.created[0].isReply, false);
      assert.ok(!("replyTo" in result.created[0]));
      assert.strictEqual(result.lines.filter((l) => l.msg === "reply_dropped")[0].reason, "INVALID_ID");
    });

    await t.test("forged fields never reach the store: isReply without replyTo, a replyPreview, reactions", async () => {
      const result = await run([], payload({
        isReply: true,
        replyPreview: { messageId: oid(), senderId: oid(), messageType: "TEXT", text: "I never said this" },
        reactions: [{ user: oid(), emoji: "👍", at: new Date() }],
      }));
      const [message] = result.created;
      assert.strictEqual(message.isReply, false);
      assert.ok(!("replyPreview" in message));
      assert.ok(!("reactions" in message));
      assert.deepStrictEqual(result.lookups, []);
      assert.deepStrictEqual(result.lines.filter((l) => l.msg === "reply_dropped"), [], "no replyTo, nothing to drop");
    });
  });
}

test("NEW_MESSAGE without a conversationId: the reply is checked against the conversation found for the pair", async () => {
  const sender = oid();
  const other = oid();
  const conversationId = new Types.ObjectId();
  const conversation = { _id: conversationId, conversationType: "PRIVATE", participants: [{ user: new Types.ObjectId(sender) }, { user: new Types.ObjectId(other) }] };
  const target = stored({ conversation: conversationId, content: "lunch?" });
  const db = install({ conversation, targets: [target] });
  try {
    await quietly(() =>
      sendPrivateMessage({ id: "s", emit: () => assert.fail("no ERROR") }, null, {
        messageType: "TEXT",
        content: "yes",
        senderId: sender,
        receiverId: other,
        replyTo: String(target._id),
      })
    );
  } finally {
    db.restore();
  }
  assert.strictEqual(db.created[0].isReply, true);
  assert.strictEqual(db.created[0].replyPreview.text, "lunch?");
});

// ---------------------------------------------------------------- the socket

test("NEW_MESSAGE over the socket: replyPreview and reactions are stripped, replyTo is kept", async () => {
  const me = oid();
  const server = await harness.startServer();
  try {
    const client = await harness.connected(server.client({ token: harness.tokenFor(me) }));
    const replyTo = oid();
    client.emit("NEW_MESSAGE", {
      messageType: "TEXT",
      content: "hi",
      receiverId: oid(),
      replyTo,
      replyPreview: { messageId: oid(), senderId: oid(), messageType: "TEXT", text: "forged" },
      reactions: [{ user: oid(), emoji: "👍" }],
    });
    await harness.until(() => server.calls.private.length === 1);
    const [data] = server.calls.private;
    assert.strictEqual(data.replyTo, replyTo);
    assert.ok(!("replyPreview" in data));
    assert.ok(!("reactions" in data));

    // A legacy socket too.
    const legacy = await harness.connected(server.client(undefined));
    legacy.emit("NEW_GROUP_MESSAGE", { messageType: "TEXT", content: "hi", senderId: oid(), conversationId: oid(), replyPreview: {}, reactions: [] });
    await harness.until(() => server.calls.group.length === 1);
    assert.ok(!("replyPreview" in server.calls.group[0]));
    assert.ok(!("reactions" in server.calls.group[0]));
    assert.ok(logged("legacy_socket", { event: "NEW_GROUP_MESSAGE" }).length >= 1);
  } finally {
    await server.close();
  }
});
