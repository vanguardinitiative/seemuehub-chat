/**
 * verifyAccessToken is shared by the REST middleware and the socket handshake,
 * so these cases pin both. Runs against the compiled dist/ (see
 * conversation-access.test.js for why): npm test
 */
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || "test-secret";
const SECRET = process.env.JWT_SECRET_KEY;

const { verifyAccessToken, stripBearer, AccessTokenError } = require("../dist/utils/access-token.js");
const { checkAuthorizationMiddleware } = require("../dist/middleware/index.js");

const userId = new Types.ObjectId().toString();
const sign = (payload, options = { expiresIn: "1d" }, secret = SECRET) => jwt.sign(payload, secret, options);
const expired = () => sign({ userId, exp: Math.floor(Date.now() / 1000) - 60 }, {});
const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AccessTokenError, `expected AccessTokenError, got ${error}`);
    return error.code;
  }
  return "no error";
};

test("verifyAccessToken", async (t) => {
  await t.test("a valid token yields its userId claim", () => {
    const verified = verifyAccessToken(sign({ userId }));
    assert.strictEqual(verified.userId, userId);
    assert.ok(verified.expiresAt > Date.now() / 1000);
  });

  await t.test("accepts the Bearer form too", () => {
    assert.strictEqual(verifyAccessToken(`Bearer ${sign({ userId })}`).userId, userId);
    assert.strictEqual(verifyAccessToken(`bearer ${sign({ userId })}`).userId, userId);
  });

  await t.test("an expired token is TOKEN_EXPIRED", () => {
    assert.strictEqual(codeOf(() => verifyAccessToken(expired())), "TOKEN_EXPIRED");
  });

  await t.test("an expired token with a bad signature is TOKEN_INVALID, not TOKEN_EXPIRED", () => {
    const forged = sign({ userId, exp: Math.floor(Date.now() / 1000) - 60 }, {}, "someone-else");
    assert.strictEqual(codeOf(() => verifyAccessToken(forged)), "TOKEN_INVALID");
  });

  await t.test("a token signed with another secret is TOKEN_INVALID", () => {
    assert.strictEqual(codeOf(() => verifyAccessToken(sign({ userId }, {}, "someone-else"))), "TOKEN_INVALID");
  });

  await t.test("garbage is TOKEN_INVALID", () => {
    assert.strictEqual(codeOf(() => verifyAccessToken("not.a.jwt")), "TOKEN_INVALID");
    assert.strictEqual(codeOf(() => verifyAccessToken(42)), "TOKEN_INVALID");
  });

  await t.test("an absent token is TOKEN_INVALID (callers decide what absent means first)", () => {
    assert.strictEqual(codeOf(() => verifyAccessToken(undefined)), "TOKEN_INVALID");
    assert.strictEqual(codeOf(() => verifyAccessToken("")), "TOKEN_INVALID");
  });

  await t.test("the backend's refresh token is not an access token", () => {
    assert.strictEqual(codeOf(() => verifyAccessToken(sign({ userId, type: "refresh" }))), "TOKEN_INVALID");
  });

  await t.test("a token without a usable userId is TOKEN_INVALID", () => {
    assert.strictEqual(codeOf(() => verifyAccessToken(sign({ id: userId }))), "TOKEN_INVALID");
    assert.strictEqual(codeOf(() => verifyAccessToken(sign({ userId: "not-an-id" }))), "TOKEN_INVALID");
  });

  await t.test("no configured secret fails closed", () => {
    assert.strictEqual(codeOf(() => verifyAccessToken(sign({ userId }), "")), "TOKEN_INVALID");
  });

  await t.test("alg none is refused", () => {
    const unsigned = jwt.sign({ userId }, null, { algorithm: "none" });
    assert.strictEqual(codeOf(() => verifyAccessToken(unsigned)), "TOKEN_INVALID");
  });
});

test("stripBearer", () => {
  assert.strictEqual(stripBearer("Bearer abc"), "abc");
  assert.strictEqual(stripBearer("  abc  "), "abc");
  assert.strictEqual(stripBearer("Bearer "), null);
  assert.strictEqual(stripBearer(""), null);
  assert.strictEqual(stripBearer(null), null);
  assert.strictEqual(stripBearer({ token: "abc" }), null);
});

test("checkAuthorizationMiddleware (REST) agrees with the socket path", async (t) => {
  const app = express();
  app.get("/who", checkAuthorizationMiddleware, (req, res) => res.json({ userId: req.user.userId }));
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const { port } = server.address();
  const get = (token) =>
    new Promise((resolve) => {
      const req = http.request(
        { port, path: "/who", headers: token ? { Authorization: token } : {} },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }
      );
      req.end();
    });

  await t.test("valid Bearer token passes with the payload on req.user", async () => {
    const res = await get(`Bearer ${sign({ userId })}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.userId, userId);
  });

  await t.test("no token is 401", async () => {
    assert.strictEqual((await get()).status, 401);
  });

  await t.test("expired token is 401 with the TOKEN_EXPIRED code", async () => {
    const res = await get(`Bearer ${expired()}`);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, "CHAT-419");
  });

  await t.test("refresh token is 401", async () => {
    assert.strictEqual((await get(`Bearer ${sign({ userId, type: "refresh" })}`)).status, 401);
  });

  server.close();
});
