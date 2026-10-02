/**
 * New-message pushes through seemuehub-backend (src/services/chat-push.ts),
 * against the compiled dist/ with no Redis, no Mongo and no backend
 * (tests/helpers/offline.js): npm test
 */
const { stub } = require("./helpers/offline");

const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const mongoose = require("mongoose");
const { Types } = mongoose;

const { env } = require("../dist/config/env.js");
const { chatPushBodies, imageUrlOf, pushChatMessage, pushReaction, reactionPushBody, snippetOf, CHAT_PUSH_PATH } = require("../dist/services/chat-push.js");
const { sendPrivateMessage } = require("../dist/controllers/message/index.js");
const { conversationModel } = require("../dist/models/conversation.js");
const { messageModel } = require("../dist/models/message.js");

const oid = () => new Types.ObjectId().toString();

/** The JSON warnings (chat_push_failed) printed while a test runs. */
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("{")) {
    try {
      warnings.push(JSON.parse(args[0]));
      return;
    } catch {}
  }
  originalWarn(...args);
};

/** A conversation as mongoose returns it: participants' `user` are ObjectIds. */
const conversationOf = (...participants) => ({
  _id: new Types.ObjectId(),
  participants: participants.map((p) =>
    typeof p === "string" ? { user: new Types.ObjectId(p), isMuted: false } : { ...p, user: new Types.ObjectId(p.user) }
  ),
});
const messageFrom = (sender, extra = {}) => ({
  _id: new Types.ObjectId(),
  sender: new Types.ObjectId(sender),
  messageType: "TEXT",
  content: "hello",
  isOrderMessage: false,
  ...extra,
});

/** Deps that record what would be posted. */
const recorder = ({ backendUrl = "https://api.example.test", internalKey = "test-key", post } = {}) => {
  const calls = [];
  return {
    calls,
    deps: {
      config: () => ({ backendUrl, internalKey }),
      post:
        post ??
        (async (url, body, options) => {
          calls.push({ url, body, options });
          return { data: { success: true, data: { sent: 1 } } };
        }),
    },
  };
};

// ---------------------------------------------------------------- the body

test("chatPushBodies", async (t) => {
  const sender = oid();
  const receiver = oid();

  await t.test("a private TEXT message: the other participant, with the text as the snippet", () => {
    const conversation = conversationOf(sender, receiver);
    const message = messageFrom(sender, { content: "  see you\n at  noon " });
    assert.deepStrictEqual(chatPushBodies(conversation, message), [
      {
        conversationId: String(conversation._id),
        senderId: sender,
        recipientIds: [receiver],
        messageType: "TEXT",
        snippet: "see you at noon",
        messageId: String(message._id),
      },
    ]);
  });

  await t.test("rich fields: the conversation's type, and a photo's or a sticker's picture", () => {
    const conversation = { ...conversationOf(sender, receiver), conversationType: "PRIVATE" };
    const photo = "https://bucket.s3.ap-southeast-1.amazonaws.com/images/p.jpg";
    const image = chatPushBodies(conversation, messageFrom(sender, { messageType: "IMAGE", content: "", attachments: [{ fileUrl: photo }] }))[0];
    assert.strictEqual(image.conversationType, "PRIVATE");
    assert.strictEqual(image.imageUrl, photo);
    const sticker = chatPushBodies(conversation, messageFrom(sender, { messageType: "STICKER", content: photo }))[0];
    assert.strictEqual(sticker.imageUrl, photo);
    const text = chatPushBodies(conversation, messageFrom(sender, { content: photo }))[0];
    assert.ok(!("imageUrl" in text), "a text message never carries a picture, even when it is a URL");
  });

  await t.test("never the sender, whichever side sends", () => {
    const conversation = conversationOf(sender, receiver);
    assert.deepStrictEqual(chatPushBodies(conversation, messageFrom(receiver))[0].recipientIds, [sender]);
  });

  await t.test("nobody to tell (only the sender is in it): no request", () => {
    assert.deepStrictEqual(chatPushBodies(conversationOf(sender), messageFrom(sender)), []);
  });

  await t.test("a participant who muted the conversation is not pushed", () => {
    const conversation = conversationOf(sender, { user: receiver, isMuted: true });
    assert.deepStrictEqual(chatPushBodies(conversation, messageFrom(sender)), []);
  });

  await t.test("an attachment has its type and no snippet", () => {
    const body = chatPushBodies(conversationOf(sender, receiver), messageFrom(sender, { messageType: "IMAGE", content: "https://cdn/x.png" }))[0];
    assert.strictEqual(body.messageType, "IMAGE");
    assert.ok(!("snippet" in body));
  });

  await t.test("order and system messages are not pushed from here (the backend notifies its own)", () => {
    const conversation = conversationOf(sender, receiver);
    assert.deepStrictEqual(chatPushBodies(conversation, messageFrom(sender, { isOrderMessage: true })), []);
    assert.deepStrictEqual(chatPushBodies(conversation, messageFrom(sender, { messageType: "SYSTEM" })), []);
    assert.deepStrictEqual(chatPushBodies(conversation, messageFrom(sender, { messageType: "ORDER_PAYMENT" })), []);
  });

  await t.test("more than 50 recipients go in several requests of at most 50", () => {
    const others = Array.from({ length: 120 }, oid);
    const bodies = chatPushBodies(conversationOf(sender, ...others), messageFrom(sender));
    assert.deepStrictEqual(bodies.map((b) => b.recipientIds.length), [50, 50, 20]);
    assert.deepStrictEqual(bodies.flatMap((b) => b.recipientIds), others);
  });

  await t.test("a repeated participant is pushed once", () => {
    assert.deepStrictEqual(chatPushBodies(conversationOf(sender, receiver, receiver), messageFrom(sender))[0].recipientIds, [receiver]);
  });

  await t.test("nothing at all for a missing conversation or message", () => {
    assert.deepStrictEqual(chatPushBodies(null, messageFrom(sender)), []);
    assert.deepStrictEqual(chatPushBodies(conversationOf(sender, receiver), null), []);
  });
});

test("imageUrlOf", async (t) => {
  await t.test("only http(s) URLs, only for IMAGE and STICKER", () => {
    assert.strictEqual(imageUrlOf({ messageType: "IMAGE", attachments: [{ fileUrl: "https://x/a.jpg" }] }), "https://x/a.jpg");
    assert.strictEqual(imageUrlOf({ messageType: "IMAGE", attachments: [{ fileUrl: "file:///a.jpg" }] }), undefined);
    assert.strictEqual(imageUrlOf({ messageType: "IMAGE" }), undefined);
    assert.strictEqual(imageUrlOf({ messageType: "STICKER", content: "STICKER", attachments: [{ fileUrl: "https://x/s.png" }] }), "https://x/s.png");
    assert.strictEqual(imageUrlOf({ messageType: "VIDEO", attachments: [{ fileUrl: "https://x/v.mp4" }] }), undefined);
    assert.strictEqual(imageUrlOf({ messageType: "IMAGE", attachments: [{ fileUrl: `https://x/${"a".repeat(2100)}` }] }), undefined);
  });
});

test("snippetOf", async (t) => {
  await t.test("folds whitespace and keeps a short text whole", () => {
    assert.strictEqual(snippetOf("  ສະບາຍດີ \n  ເຈົ້າ "), "ສະບາຍດີ ເຈົ້າ");
  });

  await t.test("clips to 140 characters without splitting one", () => {
    const text = "😀".repeat(200);
    const snippet = snippetOf(text);
    assert.strictEqual(Array.from(snippet).length, 140);
    assert.ok(snippet.endsWith("…"));
    assert.ok(!/[\uD800-\uDBFF]$/.test(snippet.slice(0, -1)), "no lone surrogate before the ellipsis");
  });

  await t.test("no snippet for empty or non-text content", () => {
    assert.strictEqual(snippetOf("   "), undefined);
    assert.strictEqual(snippetOf(undefined), undefined);
  });
});

// ---------------------------------------------------------------- the request

test("pushChatMessage", async (t) => {
  const sender = oid();
  const receiver = oid();

  await t.test("posts the body to the backend with X-Internal-Key and a short timeout", async () => {
    const { calls, deps } = recorder({ backendUrl: "https://api.example.test/" });
    const conversation = conversationOf(sender, receiver);
    await pushChatMessage(conversation, messageFrom(sender), deps);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, `https://api.example.test${CHAT_PUSH_PATH}`);
    assert.strictEqual(CHAT_PUSH_PATH, "/api/v1/internal/push/chat");
    assert.deepStrictEqual(calls[0].options, { timeout: 3000, headers: { "X-Internal-Key": "test-key" } });
    assert.deepStrictEqual(calls[0].body.recipientIds, [receiver]);
  });

  await t.test("skipped silently without BACKEND_URL or without CHAT_INTERNAL_KEY", async () => {
    for (const config of [{ backendUrl: "" }, { internalKey: "" }]) {
      const { calls, deps } = recorder(config);
      warnings.length = 0;
      await pushChatMessage(conversationOf(sender, receiver), messageFrom(sender), deps);
      assert.strictEqual(calls.length, 0);
      assert.deepStrictEqual(warnings, []);
    }
  });

  await t.test("a failing backend is swallowed, logged with ids only", async () => {
    const { deps } = recorder({
      post: async () => {
        throw Object.assign(new Error("Request failed with status code 503"), { response: { status: 503 } });
      },
    });
    const conversation = conversationOf(sender, receiver);
    warnings.length = 0;
    await pushChatMessage(conversation, messageFrom(sender, { content: "a private secret" }), deps);
    assert.deepStrictEqual(warnings, [
      { msg: "chat_push_failed", conversationId: String(conversation._id), status: 503, code: null },
    ]);
    assert.ok(!JSON.stringify(warnings).includes("secret"));
  });

  await t.test("even a throw before the request is swallowed", async () => {
    await pushChatMessage(conversationOf(sender, receiver), messageFrom(sender), {
      config: () => {
        throw new Error("boom");
      },
      post: async () => {},
    });
  });

  await t.test("reads the configuration from env by default", async () => {
    const restoreUrl = stub(env, "BACKEND_URL", undefined);
    const posted = [];
    const restorePost = stub(axios, "post", async (...args) => void posted.push(args));
    await pushChatMessage(conversationOf(sender, receiver), messageFrom(sender));
    assert.strictEqual(posted.length, 0, "no BACKEND_URL: nothing sent");
    restoreUrl();
    restorePost();
  });
});

// ---------------------------------------------------------------- wired into NEW_MESSAGE

test("a private message stored through NEW_MESSAGE", async (t) => {
  const sender = oid();
  const receiver = oid();
  const conversation = conversationOf(sender, receiver);

  /** Stubs the transaction, the two writes and axios.post; returns what was posted and emitted. */
  const install = (post) => {
    const posted = [];
    const emitted = [];
    const session = {
      startTransaction() {},
      async commitTransaction() {},
      async abortTransaction() {},
      endSession() {},
    };
    const restores = [
      stub(env, "BACKEND_URL", "https://api.example.test"),
      stub(env, "CHAT_INTERNAL_KEY", "test-key"),
      stub(mongoose, "startSession", async () => session),
      stub(messageModel, "create", async ([doc]) => [{ ...doc, _id: doc._id }]),
      stub(conversationModel, "findByIdAndUpdate", async () => conversation),
      stub(axios, "post", (url, body, options) => {
        posted.push({ url, body, options });
        return post ? post() : Promise.resolve({ data: { success: true, data: { sent: 1 } } });
      }),
    ];
    const socket = { emit: (event, payload) => emitted.push({ event, payload }) };
    return { posted, emitted, socket, restore: () => restores.reverse().forEach((r) => r()) };
  };
  const send = (socket) =>
    sendPrivateMessage(socket, {}, {
      messageType: "TEXT",
      content: "hi there",
      senderId: sender,
      receiverId: receiver,
      conversationId: String(conversation._id),
    });

  await t.test("is pushed to the receiver, not the sender", async () => {
    const { posted, emitted, socket, restore } = install();
    await send(socket);
    await new Promise((r) => setImmediate(r));
    restore();

    assert.deepStrictEqual(emitted, [], "no ERROR: the message was stored");
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].url, "https://api.example.test/api/v1/internal/push/chat");
    const { messageId, ...body } = posted[0].body;
    assert.deepStrictEqual(body, {
      conversationId: String(conversation._id),
      senderId: sender,
      recipientIds: [receiver],
      messageType: "TEXT",
      snippet: "hi there",
    });
    assert.ok(typeof messageId === "string" && messageId.length > 0, "the stored message's id");
    assert.strictEqual(posted[0].options.headers["X-Internal-Key"], "test-key");
  });

  await t.test("does not wait for the backend: a push that never answers does not hold the send", async () => {
    const { posted, socket, restore } = install(() => new Promise(() => {}));
    const outcome = await Promise.race([send(socket).then(() => "sent"), new Promise((r) => setTimeout(() => r("held"), 500))]);
    restore();
    assert.strictEqual(outcome, "sent");
    assert.strictEqual(posted.length, 1);
  });

  await t.test("a backend failure does not fail the message", async () => {
    const { emitted, socket, restore } = install(() => Promise.reject(Object.assign(new Error("down"), { code: "ECONNREFUSED" })));
    await send(socket);
    await new Promise((r) => setTimeout(r, 10));
    restore();
    assert.deepStrictEqual(emitted, []);
  });
});

// ---------------------------------------------------------------- reactions (CHAT-CONTRACT.md §3.5)

test("reactionPushBody", async (t) => {
  const author = oid();
  const reactor = oid();
  const conversationId = oid();
  const members = (extra = {}) => [
    { userId: author, isMuted: false, ...extra },
    { userId: reactor, isMuted: false },
  ];
  const push = (extra = {}) => ({ conversationId, authorId: new Types.ObjectId(author), reactorId: reactor, emoji: "❤️", members: members(), ...extra });

  await t.test("to the author, from the reactor, the emoji as the snippet", () => {
    assert.deepStrictEqual(reactionPushBody(push()), {
      conversationId,
      senderId: reactor,
      recipientIds: [author],
      messageType: "REACTION",
      snippet: "❤️",
    });
  });

  await t.test("never for a reaction to one's own message", () => {
    assert.strictEqual(reactionPushBody(push({ authorId: reactor })), null);
  });

  await t.test("not to an author who muted the conversation", () => {
    assert.strictEqual(reactionPushBody(push({ members: members({ isMuted: true }) })), null);
  });

  await t.test("not to an author who is no longer a participant (or never was, like an organization's member)", () => {
    assert.strictEqual(reactionPushBody(push({ members: [{ userId: reactor, isMuted: false }] })), null);
  });

  await t.test("not for an emoji outside the six, nor without an author", () => {
    assert.strictEqual(reactionPushBody(push({ emoji: "🔥" })), null);
    assert.strictEqual(reactionPushBody(push({ emoji: "\u2764" })), null);
    assert.strictEqual(reactionPushBody(push({ authorId: undefined })), null);
    assert.strictEqual(reactionPushBody(null), null);
  });
});

test("pushReaction", async (t) => {
  const author = oid();
  const reactor = oid();
  const push = { conversationId: oid(), authorId: author, reactorId: reactor, emoji: "👍", members: [{ userId: author, isMuted: false }, { userId: reactor, isMuted: false }] };

  await t.test("posts one request to the backend with X-Internal-Key", async () => {
    const { calls, deps } = recorder();
    await pushReaction(push, deps);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, `https://api.example.test${CHAT_PUSH_PATH}`);
    assert.deepStrictEqual(calls[0].body, { conversationId: push.conversationId, senderId: reactor, recipientIds: [author], messageType: "REACTION", snippet: "👍" });
    assert.deepStrictEqual(calls[0].options, { timeout: 3000, headers: { "X-Internal-Key": "test-key" } });
  });

  await t.test("nothing to tell: no request", async () => {
    const { calls, deps } = recorder();
    await pushReaction({ ...push, authorId: reactor }, deps);
    assert.strictEqual(calls.length, 0);
  });

  await t.test("skipped silently without BACKEND_URL or CHAT_INTERNAL_KEY", async () => {
    for (const config of [{ backendUrl: "" }, { internalKey: "" }]) {
      const { calls, deps } = recorder(config);
      await pushReaction(push, deps);
      assert.strictEqual(calls.length, 0);
    }
  });

  await t.test("a failing backend is swallowed and logged with ids only", async () => {
    const { deps } = recorder({ post: async () => Promise.reject(Object.assign(new Error("down"), { code: "ECONNREFUSED" })) });
    warnings.length = 0;
    await pushReaction(push, deps);
    assert.deepStrictEqual(warnings, [{ msg: "chat_push_failed", conversationId: push.conversationId, status: null, code: "ECONNREFUSED" }]);
  });
});
