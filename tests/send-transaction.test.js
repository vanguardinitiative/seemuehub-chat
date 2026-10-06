/**
 * A send survives a write conflict, and one conversation's sends are stored
 * one at a time, in order (worktrees/CHAT-CONTRACT.md §1.8), against the
 * compiled dist/ with no Redis and no Mongo (tests/helpers/offline.js):
 * npm test
 *
 * The app sends an album and, milliseconds later, its caption. Both
 * transactions update the same conversation document, and the second one used
 * to die of a WriteConflict (code 112, TransientTransactionError) with
 * MESSAGE_SEND_FAILED. Its SEND_MESSAGE had already gone out before the
 * commit, so the other person saw a message that was never stored.
 */
const { published, stub, query } = require("./helpers/offline");
const { startServer, tokenFor, connected, until, settle, oid } = require("./helpers/socket-harness");

const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");
const axios = require("axios");
const { Types } = mongoose;

const redis = require("../dist/config/redis.js");
const { env } = require("../dist/config/env.js");
const { conversationModel } = require("../dist/models/conversation.js");
const { messageModel } = require("../dist/models/message.js");
const { messageStatusModel } = require("../dist/models/messageStatus.js");
const { sendPrivateMessage, sendGroupMessage } = require("../dist/controllers/message/index.js");
const { withSendTransaction, isTransientTransactionError, SEND_TRANSACTION_ATTEMPTS } = require("../dist/utils/transaction.js");
const { serialize, queuedKeys } = require("../dist/utils/serialize.js");

const writeConflict = () =>
  Object.assign(new Error("WriteConflict error: this operation conflicted with another operation. Please retry your operation or multi-document transaction."), {
    code: 112,
    codeName: "WriteConflict",
    errorLabels: ["TransientTransactionError"],
  });

const duplicateId = (id) =>
  Object.assign(new Error(`E11000 duplicate key error collection: test.messages index: _id_ dup key: { _id: ObjectId('${id}') }`), {
    code: 11000,
    keyPattern: { _id: 1 },
    keyValue: { _id: new Types.ObjectId(id) },
  });

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

/** Console lines are expected here (the retries, the ERRORs); keep the output readable and keep the JSON ones. */
const quietly = async (fn) => {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  const lines = [];
  console.log = (...args) => {
    try {
      lines.push(JSON.parse(args[0]));
    } catch {}
  };
  console.error = () => {};
  console.warn = () => {};
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
};

// ---------------------------------------------------------------- utils/transaction.ts

test("isTransientTransactionError", () => {
  assert.strictEqual(isTransientTransactionError(writeConflict()), true);
  assert.strictEqual(isTransientTransactionError(Object.assign(new Error("x"), { errorLabels: ["TransientTransactionError"] })), true);
  assert.strictEqual(isTransientTransactionError(Object.assign(new Error("x"), { code: 112 })), true, "code 112 without the label");
  assert.strictEqual(isTransientTransactionError(duplicateId(oid())), false);
  assert.strictEqual(isTransientTransactionError(Object.assign(new Error("x"), { errorLabels: ["UnknownTransactionCommitResult"] })), false);
  assert.strictEqual(isTransientTransactionError(new Error("validation failed")), false);
  assert.strictEqual(isTransientTransactionError(null), false);
});

/** Sessions the way the driver behaves: inTransaction() is false once a commit was tried. */
const installSessions = ({ commitErrors = [] } = {}) => {
  const steps = [];
  const sessions = [];
  const restore = stub(mongoose, "startSession", async () => {
    const n = sessions.length + 1;
    let active = false;
    const session = {
      n,
      startTransaction() {
        active = true;
        steps.push(`start#${n}`);
      },
      inTransaction: () => active,
      async commitTransaction() {
        active = false;
        const error = commitErrors.shift();
        steps.push(error ? `commit-failed#${n}` : `commit#${n}`);
        if (error) throw error;
      },
      async abortTransaction() {
        active = false;
        steps.push(`abort#${n}`);
      },
      async endSession() {
        steps.push(`end#${n}`);
      },
    };
    sessions.push(session);
    return session;
  });
  return { steps, sessions, restore };
};

test("withSendTransaction", async (t) => {
  await t.test("a conflict: a fresh session for the next run, and the first one aborted and ended", async () => {
    const run = installSessions();
    const retries = [];
    try {
      const result = await withSendTransaction(
        async (session, attempt) => {
          run.steps.push(`work#${session.n}:${attempt}`);
          if (attempt === 1) throw writeConflict();
          return "stored";
        },
        { onRetry: (attempt, error) => retries.push([attempt, error.code]) }
      );
      assert.strictEqual(result, "stored");
    } finally {
      run.restore();
    }
    assert.deepStrictEqual(run.steps, ["start#1", "work#1:1", "abort#1", "end#1", "start#2", "work#2:2", "commit#2", "end#2"]);
    assert.deepStrictEqual(retries, [[2, 112]]);
  });

  await t.test(`gives up after ${SEND_TRANSACTION_ATTEMPTS} runs with the last error`, async () => {
    const run = installSessions();
    let runs = 0;
    try {
      await assert.rejects(
        withSendTransaction(async () => {
          runs++;
          throw writeConflict();
        }),
        (error) => error.code === 112
      );
    } finally {
      run.restore();
    }
    assert.strictEqual(runs, SEND_TRANSACTION_ATTEMPTS);
    assert.strictEqual(run.sessions.length, SEND_TRANSACTION_ATTEMPTS);
    assert.deepStrictEqual(run.steps.filter((s) => s.startsWith("end#")), ["end#1", "end#2", "end#3"]);
    assert.ok(!run.steps.some((s) => s.startsWith("commit")));
  });

  await t.test("any other failure: one run, aborted, ended, thrown", async () => {
    const run = installSessions();
    let runs = 0;
    try {
      await assert.rejects(
        withSendTransaction(async () => {
          runs++;
          throw new Error("validation failed");
        }),
        /validation failed/
      );
    } finally {
      run.restore();
    }
    assert.strictEqual(runs, 1);
    assert.deepStrictEqual(run.steps, ["start#1", "abort#1", "end#1"]);
  });

  await t.test("a commit with an unknown outcome is committed again, and the work is not run again", async () => {
    const unknown = Object.assign(new Error("connection reset"), { errorLabels: ["UnknownTransactionCommitResult"] });
    const run = installSessions({ commitErrors: [unknown] });
    let runs = 0;
    try {
      await withSendTransaction(async () => {
        runs++;
      });
    } finally {
      run.restore();
    }
    assert.strictEqual(runs, 1);
    assert.deepStrictEqual(run.steps, ["start#1", "commit-failed#1", "commit#1", "end#1"]);
  });

  await t.test("a commit that fails transiently runs the whole transaction again; no abort after a commit", async () => {
    const run = installSessions({ commitErrors: [writeConflict()] });
    let runs = 0;
    try {
      await withSendTransaction(async () => {
        runs++;
      });
    } finally {
      run.restore();
    }
    assert.strictEqual(runs, 2);
    assert.deepStrictEqual(run.steps, ["start#1", "commit-failed#1", "end#1", "start#2", "commit#2", "end#2"]);
  });
});

// ---------------------------------------------------------------- utils/serialize.ts

test("serialize", async (t) => {
  await t.test("one key: one task at a time, in the order they were queued", async () => {
    const steps = [];
    const first = deferred();
    const a = serialize("k1", async () => {
      steps.push("a:start");
      await first.promise;
      steps.push("a:end");
      return "a";
    });
    const b = serialize("k1", async () => {
      steps.push("b:start");
      return "b";
    });
    await settle(10);
    assert.deepStrictEqual(steps, ["a:start"], "b waits for a");
    first.resolve();
    assert.deepStrictEqual(await Promise.all([a, b]), ["a", "b"]);
    assert.deepStrictEqual(steps, ["a:start", "a:end", "b:start"]);
  });

  await t.test("a task that rejects rejects its caller, and the next one still runs", async () => {
    const failed = serialize("k2", async () => {
      throw new Error("boom");
    });
    const next = serialize("k2", async () => "next");
    await assert.rejects(failed, /boom/);
    assert.strictEqual(await next, "next");
  });

  await t.test("other keys do not wait", async () => {
    const held = deferred();
    const slow = serialize("k3", () => held.promise);
    const other = await serialize("k4", async () => "free");
    assert.strictEqual(other, "free");
    held.resolve();
    await slow;
  });

  await t.test("the key is forgotten once its last task settles", async () => {
    await Promise.allSettled([serialize("k5", async () => {}), serialize("k5", async () => Promise.reject(new Error("x")))]);
    assert.strictEqual(queuedKeys(), 0);
  });

  await t.test("a stuck task holds the next one only up to the wait limit", async () => {
    const stuck = serialize("k6", () => new Promise(() => {}), 30);
    void stuck;
    const started = Date.now();
    const next = await serialize("k6", async () => "went", 30);
    assert.strictEqual(next, "went");
    assert.ok(Date.now() - started < 1000);
  });
});

// ---------------------------------------------------------------- the sends

/**
 * Stubs Mongo, Redis and the push for the send controllers. `insert` and
 * `update` decide each write (by the message's content and the run it is
 * in); everything that happens lands in `steps`, labelled with the
 * message's content.
 */
const installSend = ({ insert, update, commitErrors = [], stored = null } = {}) => {
  const steps = [];
  const emitted = [];
  const inserted = [];
  const pushes = [];
  let sessions = 0;
  const restores = [
    stub(mongoose, "startSession", async () => {
      const n = ++sessions;
      let active = false;
      const session = {
        label: `#${n}`,
        startTransaction() {
          active = true;
        },
        inTransaction: () => active,
        async commitTransaction() {
          active = false;
          const error = commitErrors.shift();
          steps.push(`${session.label}:${error ? "commit-failed" : "commit"}`);
          if (error) throw error;
        },
        async abortTransaction() {
          active = false;
          steps.push(`${session.label}:abort`);
        },
        endSession() {},
      };
      return session;
    }),
    stub(messageModel, "create", async ([doc], { session }) => {
      session.label = doc.content;
      steps.push(`${doc.content}:insert`);
      inserted.push({ ...doc });
      if (insert) await insert(doc);
      return [{ ...doc }];
    }),
    stub(conversationModel, "findByIdAndUpdate", async (id, change) => {
      if (update) await update(change.latestMessageData);
      return {
        _id: id,
        conversationType: "PRIVATE",
        participants: [{ user: new Types.ObjectId(), isMuted: false }, { user: new Types.ObjectId(), isMuted: false }],
        latestMessageData: change.latestMessageData,
      };
    }),
    stub(conversationModel, "findOne", () => query(null)),
    stub(conversationModel, "create", async ([doc]) => [{ _id: new Types.ObjectId(), ...doc }]),
    stub(messageModel, "findOne", (filter) => {
      steps.push("lookup");
      return query(stored && String(stored._id) === String(filter._id) && String(stored.sender) === String(filter.sender) ? stored : null);
    }),
    stub(messageStatusModel, "insertMany", async () => []),
    stub(redis.pub, "publish", async (channel, message) => {
      const parsed = JSON.parse(message);
      steps.push(`${parsed.messageData?.content}:publish`);
      published.push({ channel, message: parsed });
    }),
    stub(env, "BACKEND_URL", "https://api.example.test"),
    stub(env, "CHAT_INTERNAL_KEY", "test-key"),
    stub(axios, "post", async (url, body) => {
      pushes.push(body);
      return { data: { success: true } };
    }),
  ];
  const socket = { id: "socket-1", emit: (event, payload) => emitted.push({ event, payload }) };
  published.length = 0;
  return { steps, emitted, inserted, pushes, socket, sessions: () => sessions, restore: () => restores.reverse().forEach((r) => r()) };
};

const SENDS = [
  ["NEW_MESSAGE (sendPrivateMessage)", sendPrivateMessage, "NEW_MESSAGE"],
  ["NEW_GROUP_MESSAGE (sendGroupMessage)", sendGroupMessage, "NEW_GROUP_MESSAGE"],
];

for (const [label, send, event] of SENDS) {
  test(`${label}: write conflicts`, async (t) => {
    const sender = oid();
    const payload = (extra = {}) => ({ _id: oid(), messageType: "TEXT", content: "caption", senderId: sender, receiverId: oid(), conversationId: oid(), ...extra });

    await t.test("one conflict: stored on the second run, one commit, one SEND_MESSAGE, no ERROR", async () => {
      let conflicts = 1;
      const run = installSend({
        update: async () => {
          if (conflicts-- > 0) throw writeConflict();
        },
      });
      const data = payload();
      let lines;
      try {
        lines = await quietly(() => send(run.socket, null, data));
        await settle(10);
      } finally {
        run.restore();
      }
      assert.deepStrictEqual(run.emitted, [], "no ERROR");
      assert.deepStrictEqual(run.steps, ["caption:insert", "caption:abort", "caption:insert", "caption:commit", "caption:publish"]);
      assert.deepStrictEqual(run.inserted.map((doc) => String(doc._id)), [data._id, data._id], "the same message both times");
      assert.strictEqual(published.filter((p) => p.channel === "SEND_MESSAGE").length, 1);
      assert.strictEqual(run.sessions(), 2);
      const retries = lines.filter((line) => line?.msg === "message_send_retry");
      assert.deepStrictEqual(retries, [
        { msg: "message_send_retry", event, attempt: 2, code: 112, socketId: "socket-1", userId: sender, conversationId: data.conversationId, _id: data._id },
      ]);
    });

    await t.test("a server-chosen _id is chosen once: the retry inserts the same one", async () => {
      let conflicts = 1;
      const run = installSend({
        insert: async () => {
          if (conflicts-- > 0) throw writeConflict();
        },
      });
      try {
        await quietly(() => send(run.socket, null, payload({ _id: undefined })));
      } finally {
        run.restore();
      }
      assert.deepStrictEqual(run.emitted, []);
      assert.strictEqual(run.inserted.length, 2);
      assert.strictEqual(String(run.inserted[0]._id), String(run.inserted[1]._id));
    });

    await t.test(`${SEND_TRANSACTION_ATTEMPTS} conflicts: MESSAGE_SEND_FAILED with the conversationId, nothing published or pushed`, async () => {
      const run = installSend({
        update: async () => {
          throw writeConflict();
        },
      });
      const data = payload();
      try {
        await quietly(() => send(run.socket, null, data));
        await settle(10);
      } finally {
        run.restore();
      }
      assert.strictEqual(run.sessions(), SEND_TRANSACTION_ATTEMPTS);
      assert.deepStrictEqual(run.emitted.map((e) => e.event), ["ERROR"]);
      const [{ payload: error }] = run.emitted;
      assert.strictEqual(error.code, "MESSAGE_SEND_FAILED");
      assert.strictEqual(error.event, event);
      assert.strictEqual(error.conversationId, data.conversationId);
      assert.strictEqual(error._id, data._id);
      assert.deepStrictEqual(published, [], "a message that was not stored is never delivered");
      assert.deepStrictEqual(run.pushes, []);
      assert.ok(!run.steps.some((s) => s.endsWith(":commit")));
      assert.ok(!run.steps.includes("lookup"), "a conflict is not a duplicate: no lookup");
    });

    await t.test("SEND_MESSAGE goes out after the commit, never before", async () => {
      const run = installSend();
      try {
        await quietly(() => send(run.socket, null, payload({ content: "hello" })));
      } finally {
        run.restore();
      }
      assert.deepStrictEqual(run.steps, ["hello:insert", "hello:commit", "hello:publish"]);
    });

    await t.test("a commit that fails: no SEND_MESSAGE for it", async () => {
      const failure = Object.assign(new Error("commit failed"), { code: 251 });
      const run = installSend({ commitErrors: [failure] });
      try {
        await quietly(() => send(run.socket, null, payload({ content: "lost" })));
      } finally {
        run.restore();
      }
      assert.deepStrictEqual(run.steps, ["lost:insert", "lost:commit-failed"]);
      assert.deepStrictEqual(published, []);
      assert.strictEqual(run.emitted[0].payload.code, "MESSAGE_SEND_FAILED");
    });

    await t.test("two sends to one conversation: the second starts after the first is committed and published, in order", async () => {
      const conversationId = oid();
      const albumHeld = deferred();
      const run = installSend({
        // The album's insert is slow; the caption's would win a race.
        insert: async (doc) => {
          if (doc.content === "album") await albumHeld.promise;
        },
      });
      try {
        await quietly(async () => {
          const album = send(run.socket, null, payload({ conversationId, content: "album", messageType: "IMAGE" }));
          const caption = send(run.socket, null, payload({ conversationId, content: "caption" }));
          await settle(20);
          assert.deepStrictEqual(run.steps, ["album:insert"], "the caption waits for the album");
          albumHeld.resolve();
          await Promise.all([album, caption]);
        });
      } finally {
        run.restore();
      }
      assert.deepStrictEqual(run.steps, ["album:insert", "album:commit", "album:publish", "caption:insert", "caption:commit", "caption:publish"]);
      assert.deepStrictEqual(run.emitted, []);
      assert.deepStrictEqual(published.map((p) => p.message.messageData.content), ["album", "caption"]);
    });

    await t.test("sends to two conversations do not wait for each other", async () => {
      const held = deferred();
      const run = installSend({
        insert: async (doc) => {
          if (doc.content === "slow") await held.promise;
        },
      });
      try {
        await quietly(async () => {
          const slow = send(run.socket, null, payload({ content: "slow" }));
          await send(run.socket, null, payload({ content: "fast" }));
          assert.ok(run.steps.includes("fast:publish"));
          assert.ok(!run.steps.includes("slow:commit"));
          held.resolve();
          await slow;
        });
      } finally {
        run.restore();
      }
    });

    await t.test("a send that fails does not hold up the next one", async () => {
      const conversationId = oid();
      const run = installSend({
        insert: async (doc) => {
          if (doc.content === "bad") throw new Error("validation failed");
        },
      });
      try {
        await quietly(() =>
          Promise.all([
            send(run.socket, null, payload({ conversationId, content: "bad" })),
            send(run.socket, null, payload({ conversationId, content: "good" })),
          ])
        );
      } finally {
        run.restore();
      }
      assert.deepStrictEqual(run.emitted.map((e) => [e.event, e.payload.code]), [["ERROR", "MESSAGE_SEND_FAILED"]]);
      assert.deepStrictEqual(published.map((p) => p.message.messageData.content), ["good"]);
      assert.strictEqual(queuedKeys(), 0, "the queue is gone once both are done");
    });

    await t.test("a retry whose earlier commit went through: the duplicate key confirms it to the sender, no ERROR", async () => {
      const data = payload({ content: "twice" });
      const stored = { _id: new Types.ObjectId(data._id), sender: new Types.ObjectId(sender), conversation: new Types.ObjectId(data.conversationId), messageType: "TEXT", content: "twice" };
      let runs = 0;
      const run = installSend({
        // The first commit's answer is a transient failure, but it was kept:
        // the second run's insert finds the message there.
        commitErrors: [writeConflict()],
        insert: async () => {
          if (++runs === 2) throw duplicateId(data._id);
        },
        stored,
      });
      let lines;
      try {
        lines = await quietly(() => send(run.socket, null, data));
      } finally {
        run.restore();
      }
      assert.deepStrictEqual(run.emitted, [
        { event: "CONVERSATION_LISTENING", payload: { type: "NEW_MESSAGE", response: JSON.parse(JSON.stringify(stored)) } },
      ]);
      assert.deepStrictEqual(run.steps, ["twice:insert", "twice:commit-failed", "twice:insert", "twice:abort", "lookup"]);
      assert.strictEqual(lines.filter((line) => line?.msg === "message_resent").length, 1);
    });

    await t.test("the same with a server-chosen _id: the id it chose is looked up", async () => {
      const data = payload({ _id: undefined, content: "mine" });
      let runs = 0;
      let chosen;
      const run = installSend({
        commitErrors: [writeConflict()],
        insert: async (doc) => {
          chosen = String(doc._id);
          if (++runs === 2) throw duplicateId(chosen);
        },
      });
      // The lookup answers the message the first run stored.
      const lookups = [];
      const restoreLookup = stub(messageModel, "findOne", (filter) => {
        lookups.push(filter);
        return query({ _id: new Types.ObjectId(String(filter._id)), sender: new Types.ObjectId(sender), content: "mine" });
      });
      try {
        await quietly(() => send(run.socket, null, data));
      } finally {
        restoreLookup();
        run.restore();
      }
      assert.strictEqual(lookups.length, 1);
      assert.strictEqual(String(lookups[0]._id), chosen);
      assert.deepStrictEqual(run.emitted.map((e) => [e.event, e.payload.type]), [["CONVERSATION_LISTENING", "NEW_MESSAGE"]]);
    });
  });
}

test("NEW_MESSAGE without a conversationId: the first messages between two people are queued together too", async () => {
  const sender = oid();
  const receiver = oid();
  const held = deferred();
  const run = installSend({
    insert: async (doc) => {
      if (doc.content === "first") await held.promise;
    },
  });
  try {
    await quietly(async () => {
      const first = sendPrivateMessage(run.socket, null, { messageType: "TEXT", content: "first", senderId: sender, receiverId: receiver });
      // The reply, the other way round: the same pair.
      const second = sendPrivateMessage(run.socket, null, { messageType: "TEXT", content: "second", senderId: receiver, receiverId: sender });
      await settle(20);
      assert.deepStrictEqual(run.steps, ["first:insert"]);
      held.resolve();
      await Promise.all([first, second]);
    });
  } finally {
    run.restore();
  }
  assert.deepStrictEqual(run.steps, ["first:insert", "first:commit", "first:publish", "second:insert", "second:commit", "second:publish"]);
});

// ---------------------------------------------------------------- the socket

test("one socket's messages reach the controller in the order they came", async (t) => {
  const me = oid();
  const conversationId = oid();

  await t.test("even when the first one's membership lookup answers last", async () => {
    let lookups = 0;
    const calls = [];
    const server = await startServer({
      mode: "enforce",
      deps: {
        isParticipant: async () => {
          // The album's lookup is slow, the caption's is not.
          if (++lookups === 1) await settle(60);
          return true;
        },
        sendPrivateMessage: async (_socket, _io, data) => {
          calls.push(data.content);
        },
      },
    });
    try {
      const client = await connected(server.client({ token: tokenFor(me) }));
      client.emit("NEW_MESSAGE", { _id: oid(), messageType: "IMAGE", content: "album", conversationId });
      client.emit("NEW_MESSAGE", { _id: oid(), messageType: "TEXT", content: "caption", conversationId });
      await until(() => calls.length === 2);
      assert.deepStrictEqual(calls, ["album", "caption"]);
    } finally {
      await server.close();
    }
  });

  await t.test("the next message waits for the hand-over only, not for the send to finish", async () => {
    const calls = [];
    const server = await startServer({
      mode: "enforce",
      deps: {
        isParticipant: async () => true,
        sendPrivateMessage: (_socket, _io, data) => {
          calls.push(data.content);
          return new Promise(() => {});
        },
      },
    });
    try {
      const client = await connected(server.client({ token: tokenFor(me) }));
      client.emit("NEW_MESSAGE", { _id: oid(), messageType: "TEXT", content: "one", conversationId });
      client.emit("NEW_MESSAGE", { _id: oid(), messageType: "TEXT", content: "two", conversationId });
      await until(() => calls.length === 2);
      assert.deepStrictEqual(calls, ["one", "two"]);
    } finally {
      await server.close();
    }
  });

  await t.test("a refused message does not hold up the next", async () => {
    const calls = [];
    const server = await startServer({
      mode: "enforce",
      deps: {
        isParticipant: async (id) => id === conversationId,
        sendPrivateMessage: async (_socket, _io, data) => {
          calls.push(data.content);
        },
      },
    });
    try {
      const client = await connected(server.client({ token: tokenFor(me) }));
      const errors = [];
      client.on("ERROR", (error) => errors.push(error.code));
      client.emit("NEW_MESSAGE", { _id: oid(), messageType: "TEXT", content: "elsewhere", conversationId: oid() });
      client.emit("NEW_MESSAGE", { _id: oid(), messageType: "SYSTEM", content: "forged", conversationId });
      client.emit("NEW_MESSAGE", { _id: oid(), messageType: "TEXT", content: "here", conversationId });
      await until(() => calls.length === 1 && errors.length === 2);
      assert.deepStrictEqual(calls, ["here"]);
      assert.deepStrictEqual(errors, ["NOT_PARTICIPANT", "INVALID_PAYLOAD"]);
    } finally {
      await server.close();
    }
  });
});
