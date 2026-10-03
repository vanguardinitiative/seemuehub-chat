/**
 * Company ↔ candidate chat's pure parts and its backend client
 * (worktrees/ORG-CHAT-CONTRACT.md §2.2, §2.5, §3), against the compiled dist/
 * with no Redis, no Mongo and no backend: npm test
 *
 * - chatPushBodies for a company conversation: CANDIDATE for a company
 *   message (unless muted), ORGANIZATION for the candidate's; nothing with
 *   the switch off.
 * - services/org-chat-auth.ts: LIST/READ/SEND cached 60 s, OPEN never; the
 *   backend unreachable or unconfigured is OrgChatUnavailableError.
 * - utils/org-chat.ts: the OPEN body, the candidate, the company's unread.
 */
require("./helpers/offline");

const test = require("node:test");
const assert = require("node:assert");
const { Types } = require("mongoose");

const { chatPushBodies } = require("../dist/services/chat-push.js");
const auth = require("../dist/services/org-chat-auth.js");
const orgChat = require("../dist/utils/org-chat.js");

const oid = () => new Types.ObjectId().toString();
const ORG = oid();
const MEMBER = oid();
const CANDIDATE = oid();

const companyConversation = (overrides = {}) => ({
  _id: new Types.ObjectId(),
  conversationType: "PRIVATE",
  organizationId: new Types.ObjectId(ORG),
  organization: { name: "Lao Coffee Co", nameLao: "ບໍລິສັດ ກາເຟລາວ" },
  participants: [{ user: new Types.ObjectId(CANDIDATE), isMuted: false }],
  ...overrides,
});
const message = (sender, extra = {}) => ({ _id: new Types.ObjectId(), sender: new Types.ObjectId(sender), messageType: "TEXT", content: "hello", ...extra });

test("chatPushBodies for a company conversation", async (t) => {
  const on = { orgChat: true };

  await t.test("a company message: to the candidate, as the company", () => {
    const conversation = companyConversation();
    const [body, ...rest] = chatPushBodies(conversation, message(MEMBER, { sendAsOrganizationId: new Types.ObjectId(ORG) }), on);
    assert.deepStrictEqual(rest, []);
    const { messageId, ...fields } = body;
    assert.deepStrictEqual(fields, {
      conversationId: String(conversation._id),
      senderId: MEMBER,
      recipientIds: [CANDIDATE],
      messageType: "TEXT",
      snippet: "hello",
      conversationType: "PRIVATE",
      organizationId: ORG,
      audience: "CANDIDATE",
      senderName: "ບໍລິສັດ ກາເຟລາວ",
    });
    assert.ok(messageId);
  });

  await t.test("without a Lao name, the name; without a snapshot, no senderName", () => {
    const [english] = chatPushBodies(companyConversation({ organization: { name: "Lao Coffee Co" } }), message(MEMBER, { sendAsOrganizationId: ORG }), on);
    assert.strictEqual(english.senderName, "Lao Coffee Co");
    const [none] = chatPushBodies(companyConversation({ organization: undefined }), message(MEMBER, { sendAsOrganizationId: ORG }), on);
    assert.ok(!("senderName" in none));
  });

  await t.test("a candidate who muted it is not pushed", () => {
    const muted = companyConversation({ participants: [{ user: new Types.ObjectId(CANDIDATE), isMuted: true }] });
    assert.deepStrictEqual(chatPushBodies(muted, message(MEMBER, { sendAsOrganizationId: ORG }), on), []);
  });

  await t.test("the candidate's message: to the company, with no recipients", () => {
    const conversation = companyConversation();
    const bodies = chatPushBodies(conversation, message(CANDIDATE, { messageType: "IMAGE", content: "", attachments: [{ fileUrl: "https://img.test/a.jpg" }] }), on);
    assert.strictEqual(bodies.length, 1);
    const { messageId, ...fields } = bodies[0];
    assert.deepStrictEqual(fields, {
      conversationId: String(conversation._id),
      senderId: CANDIDATE,
      recipientIds: [],
      messageType: "IMAGE",
      conversationType: "PRIVATE",
      imageUrl: "https://img.test/a.jpg",
      organizationId: ORG,
      audience: "ORGANIZATION",
    });
  });

  await t.test("switched off (the default): nothing, as before company chat", () => {
    assert.deepStrictEqual(chatPushBodies(companyConversation(), message(MEMBER, { sendAsOrganizationId: ORG })), []);
    assert.deepStrictEqual(chatPushBodies(companyConversation(), message(CANDIDATE)), []);
  });

  await t.test("any other conversation is untouched by the switch", () => {
    const dm = { _id: new Types.ObjectId(), participants: [{ user: new Types.ObjectId(CANDIDATE) }, { user: new Types.ObjectId(MEMBER) }] };
    const sent = message(MEMBER);
    const [off] = chatPushBodies(dm, sent);
    const [onBody] = chatPushBodies(dm, sent, on);
    assert.deepStrictEqual(onBody, off);
    assert.ok(!("audience" in off) && !("organizationId" in off));
  });
});

// ---------------------------------------------------------------- the backend client

/** The client's deps over a fake backend and a Map cache. */
const deps = ({ answer = { allow: true, organization: null }, post } = {}) => {
  const calls = [];
  const cache = new Map();
  return {
    calls,
    cache,
    deps: {
      config: () => ({ backendUrl: "https://api.test/", internalKey: "test-key" }),
      post:
        post ??
        (async (url, body, options) => {
          calls.push({ url, body, options });
          return { data: { success: true, data: typeof answer === "function" ? answer(body) : answer } };
        }),
      cache: {
        get: async (key) => cache.get(key)?.value ?? null,
        set: async (key, value, ttlSeconds) => void cache.set(key, { value, ttlSeconds }),
      },
    },
  };
};

test("authorizeOrgChat", async (t) => {
  await t.test("posts to the backend with X-Internal-Key and a 2 s timeout", async () => {
    const { calls, deps: d } = deps();
    await auth.authorizeOrgChat({ action: "OPEN", organizationId: ORG, actorUserId: MEMBER, candidateUserId: CANDIDATE, basis: "UNLOCK" }, d);
    assert.strictEqual(calls[0].url, "https://api.test/api/v1/internal/org-chat/authorize");
    assert.deepStrictEqual(calls[0].options, { timeout: 2000, headers: { "X-Internal-Key": "test-key" } });
  });

  await t.test("LIST, READ and SEND share one answer per organization and member for 60 s; OPEN always asks", async () => {
    const { calls, cache, deps: d } = deps({ answer: { allow: false, code: "ORG_CHAT_FORBIDDEN", organization: null } });
    for (const action of ["LIST", "READ", "SEND", "SEND"]) {
      const result = await auth.authorizeOrgChat({ action, organizationId: ORG, actorUserId: MEMBER }, d);
      assert.deepStrictEqual(result, { allow: false, code: "ORG_CHAT_FORBIDDEN", organization: null });
    }
    assert.strictEqual(calls.length, 1, "refusals are cached too");
    assert.deepStrictEqual([...cache.keys()], [`orgchat:auth:${ORG}:${MEMBER}`]);
    assert.strictEqual(cache.get(`orgchat:auth:${ORG}:${MEMBER}`).ttlSeconds, 60);

    for (let n = 0; n < 2; n++) await auth.authorizeOrgChat({ action: "OPEN", organizationId: ORG, actorUserId: MEMBER, candidateUserId: CANDIDATE, basis: "UNLOCK" }, d);
    assert.strictEqual(calls.length, 3);
  });

  await t.test("a value in the cache it did not write is ignored", async () => {
    const { calls, cache, deps: d } = deps();
    cache.set(`orgchat:auth:${ORG}:${MEMBER}`, { value: "not json" });
    await auth.authorizeOrgChat({ action: "LIST", organizationId: ORG, actorUserId: MEMBER }, d);
    assert.strictEqual(calls.length, 1);
  });

  await t.test("unreachable, unconfigured, or answering no decision: OrgChatUnavailableError, never a yes, never cached", async () => {
    const down = deps({
      post: async () => {
        throw Object.assign(new Error("timeout of 2000ms exceeded"), { code: "ECONNABORTED" });
      },
    });
    await assert.rejects(auth.authorizeOrgChat({ action: "SEND", organizationId: ORG, actorUserId: MEMBER }, down.deps), auth.OrgChatUnavailableError);
    assert.strictEqual(down.cache.size, 0);

    const garbage = deps({ answer: { yes: true } });
    await assert.rejects(auth.authorizeOrgChat({ action: "LIST", organizationId: ORG, actorUserId: MEMBER }, garbage.deps), auth.OrgChatUnavailableError);

    const unconfigured = deps();
    unconfigured.deps.config = () => ({ backendUrl: undefined, internalKey: "k" });
    await assert.rejects(auth.authorizeOrgChat({ action: "OPEN", organizationId: ORG, actorUserId: MEMBER }, unconfigured.deps), auth.OrgChatUnavailableError);
  });

  await t.test("reportOpened and reportBlock: best effort, never throw", async () => {
    const { calls, deps: d } = deps({ answer: (body) => ("userId" in body ? { blocked: true } : { remainingToday: 12 }) });
    assert.strictEqual(await auth.reportOpened(ORG, d), 12);
    assert.strictEqual(await auth.reportBlock({ userId: CANDIDATE, organizationId: ORG, conversationId: oid() }, d), true);
    assert.deepStrictEqual(calls.map((call) => new URL(call.url).pathname), ["/api/v1/internal/org-chat/opened", "/api/v1/internal/org-chat/blocks"]);

    const down = deps({
      post: async () => {
        throw new Error("down");
      },
    });
    assert.strictEqual(await auth.reportOpened(ORG, down.deps), null);
    assert.strictEqual(await auth.reportBlock({ userId: CANDIDATE, organizationId: ORG, conversationId: oid() }, down.deps), false);
  });
});

// ---------------------------------------------------------------- utils/org-chat

test("parseOpenBody", () => {
  const good = { candidateUserId: CANDIDATE.toUpperCase(), basis: "MUTUAL_MATCH", matchId: oid(), firstMessage: "  ສະບາຍດີ  " };
  const parsed = orgChat.parseOpenBody(good);
  assert.strictEqual(parsed.ok, true);
  assert.deepStrictEqual(parsed.value, { candidateUserId: CANDIDATE, basis: "MUTUAL_MATCH", matchId: good.matchId, firstMessage: "ສະບາຍດີ" });

  for (const [body, field] of [
    [{ ...good, candidateUserId: undefined }, "candidateUserId"],
    [{ ...good, basis: undefined }, "basis"],
    [{ ...good, basis: "unlock" }, "basis"],
    [{ ...good, applicationId: "x" }, "applicationId"],
    [{ ...good, firstMessage: "" }, "firstMessage"],
    [{ ...good, firstMessage: 42 }, "firstMessage"],
    [{ ...good, firstMessage: "ກ".repeat(2001) }, "firstMessage"],
    [null, "candidateUserId"],
  ]) {
    assert.deepStrictEqual(orgChat.parseOpenBody(body), { ok: false, field });
  }
  // 2000 characters, not UTF-16 units.
  assert.strictEqual(orgChat.parseOpenBody({ ...good, firstMessage: "😀".repeat(2000) }).ok, true);
});

test("candidateOf, isBlocked, orgUnread", () => {
  const base = { organizationId: ORG, candidateUserId: CANDIDATE, participants: [{ user: CANDIDATE }] };
  assert.strictEqual(orgChat.candidateOf(base), CANDIDATE);
  // Opened before candidateUserId: the one participant.
  assert.strictEqual(orgChat.candidateOf({ organizationId: ORG, participants: [{ user: new Types.ObjectId(CANDIDATE) }] }), CANDIDATE);
  assert.strictEqual(orgChat.candidateOf({ participants: [{ user: CANDIDATE }] }), null, "not a company conversation");

  assert.strictEqual(orgChat.isBlocked({ ...base, candidateBlockedAt: new Date() }), true);
  assert.strictEqual(orgChat.isBlocked(base), false);
  assert.strictEqual(orgChat.isBlocked({ candidateBlockedAt: new Date() }), false, "only a company conversation is blocked");

  const sendAt = new Date("2026-10-02T10:00:00Z");
  const fromCandidate = { ...base, latestMessageData: { senderId: CANDIDATE, sendAt } };
  assert.strictEqual(orgChat.orgUnread(fromCandidate), true);
  assert.strictEqual(orgChat.orgUnread({ ...fromCandidate, orgSide: { lastReadAt: new Date("2026-10-02T09:59:59Z") } }), true);
  assert.strictEqual(orgChat.orgUnread({ ...fromCandidate, orgSide: { lastReadAt: sendAt } }), false);
  assert.strictEqual(orgChat.orgUnread({ ...base, latestMessageData: { senderId: MEMBER, sendAt } }), false, "the company's own message");
  assert.strictEqual(orgChat.orgUnread({ ...base, latestMessageData: {} }), false);
});

test("orgChatError: the contract's statuses", () => {
  assert.deepStrictEqual(
    ["ORG_CHAT_DISABLED", "ORG_CHAT_NOT_MEMBER", "ORG_CHAT_FORBIDDEN", "ORG_CHAT_NOT_ELIGIBLE", "ORG_CHAT_BLOCKED", "ORG_CHAT_DAILY_LIMIT", "ORG_CHAT_UNAVAILABLE"].map(
      (code) => orgChat.orgChatError(code).status
    ),
    [403, 403, 403, 403, 403, 429, 503]
  );
  assert.deepStrictEqual(orgChat.orgChatError("SOMETHING_NEW"), { status: 403, code: "SOMETHING_NEW", message: "Forbidden" });
});
