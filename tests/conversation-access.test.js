/**
 * Runs against the COMPILED dist/, on purpose.
 *
 * dist/ is what the Dockerfile actually starts (`nodemon dist/index.js`, with no
 * build step), so testing src/ would prove nothing about what ships. Run with:
 *   npm run build && node --test tests/
 *
 * Mongo is not connected here, which is exactly why these cases are the ones
 * worth pinning: every one of them must be answered before the handler reaches
 * the database. If an unauthenticated request ever gets far enough to query, it
 * hangs here instead of returning — a visible failure rather than a silent leak.
 */
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || "test-secret";

const conversationRoute = require("../dist/routes/conversation.js").default;
const { participantOf, userIdOf } = require("../dist/utils/conversation-access.js");
const { Types } = require("mongoose");

const app = express();
app.use(express.json());
app.use("/conversations", conversationRoute);

const listen = () => new Promise((r) => { const s = app.listen(0, () => r(s)); });
const get = (port, path, token) =>
  new Promise((resolve) => {
    const req = http.request(
      { port, path, method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on("error", () => resolve(0));
    req.end();
  });

test("GET /conversations/:id", async (t) => {
  const server = await listen();
  const { port } = server.address();
  const id = new Types.ObjectId().toString();
  const token = jwt.sign({ userId: new Types.ObjectId().toString() }, process.env.JWT_SECRET_KEY);

  await t.test("no token is rejected before anything is read", async () => {
    // The whole bug: this used to reach the handler and return the conversation.
    assert.strictEqual(await get(port, `/conversations/${id}`), 401);
  });

  await t.test("a garbage token is rejected", async () => {
    assert.strictEqual(await get(port, `/conversations/${id}`, "not.a.jwt"), 401);
  });

  await t.test("a malformed id is a 400, not a 500", async () => {
    // findOne({_id: "abc"}) throws a CastError, which the handler's catch turned
    // into "Internal Server Error".
    assert.strictEqual(await get(port, "/conversations/not-an-objectid", token), 400);
  });

  server.close();
});

test("userIdOf", async (t) => {
  const id = new Types.ObjectId().toString();
  await t.test("reads userId from the verified token payload", () => {
    assert.strictEqual(userIdOf({ user: { userId: id } }), id);
  });
  await t.test("returns null when the payload has no userId", () => {
    assert.strictEqual(userIdOf({}), null);
    assert.strictEqual(userIdOf({ user: {} }), null);
  });
  await t.test("returns null for a non-ObjectId, rather than letting Mongo throw", () => {
    assert.strictEqual(userIdOf({ user: { userId: "not-an-id" } }), null);
  });
});

test("participantOf builds a filter, not a post-fetch check", () => {
  const id = new Types.ObjectId().toString();
  const filter = participantOf(id);
  assert.ok(filter["participants.user"], "must filter on participants.user");
  assert.strictEqual(String(filter["participants.user"]), id);
});
