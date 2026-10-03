/**
 * In-memory stand-ins for company ↔ candidate chat's tests
 * (worktrees/ORG-CHAT-CONTRACT.md §3.5): the `conversations` and `messages`
 * collections, and seemuehub-backend's internal routes.
 *
 * - The collections evaluate the real filters (sift, the matcher mongoose
 *   depends on) and apply $set / $max (positional `$[me]` included) the way
 *   MongoDB would, bumping `updatedAt` unless the write passes
 *   `timestamps: false`. Conversations enforce the partial unique index on
 *   { organizationId, candidateUserId }.
 * - `.save()` on a conversation fails the test: every write must be an update.
 * - The backend is axios.post, answering authorize / opened / blocks and
 *   recording the pushes.
 *
 * Ids are stored as strings. Require ./offline first. Not a test file.
 */
const axios = require("axios");
const assert = require("node:assert");
const { Types } = require("mongoose");
const siftModule = require("sift");
const { stub } = require("./offline");

const sift = siftModule.default ?? siftModule;

const { conversationModel } = require("../../dist/models/conversation.js");
const { messageModel } = require("../../dist/models/message.js");

const oid = () => new Types.ObjectId().toString();

/** ObjectIds (any bson copy) become strings, recursively; Dates are kept; undefined fields are dropped. */
const plain = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === "object" && typeof value.toHexString === "function") return value.toHexString();
  if (typeof value !== "object" || value instanceof Date || value instanceof RegExp) return value;
  if (Array.isArray(value)) return value.map(plain);
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, plain(v)]));
};
const matches = (filter) => sift(plain(filter ?? {}));
const copy = (doc) => (doc ? structuredClone(doc) : doc);

/** The elements of `array` an arrayFilters entry for `name` selects (`{ "me.user": id }`). */
const selected = (array, name, arrayFilters = []) => {
  const entry = arrayFilters.find((filter) => Object.keys(filter).some((key) => key === name || key.startsWith(`${name}.`)));
  if (!entry) return array;
  const inner = Object.fromEntries(Object.entries(entry).map(([key, value]) => [key.slice(name.length + 1), value]));
  const test = matches(inner);
  return array.filter((element) => test(element));
};

/** Every (container, key) a dotted path with `$[name]` reaches, creating plain objects on the way. */
const targets = (doc, path, arrayFilters) => {
  const parts = path.split(".");
  let level = [doc];
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = [];
    for (const node of level) {
      const positional = /^\$\[(\w+)\]$/.exec(part);
      if (positional) {
        next.push(...selected(Array.isArray(node) ? node : [], positional[1], arrayFilters));
      } else {
        if (node[part] === undefined || node[part] === null) node[part] = {};
        next.push(node[part]);
      }
    }
    level = next;
  }
  return level.map((node) => [node, parts[parts.length - 1]]);
};

const timeOf = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

/** Applies an update document to `doc` in place. */
const applyUpdate = (doc, update, options = {}) => {
  const { arrayFilters } = options;
  for (const [path, value] of Object.entries(plain(update.$set ?? {}))) {
    for (const [node, key] of targets(doc, path, arrayFilters)) node[key] = copy(value);
  }
  for (const [path, value] of Object.entries(plain(update.$max ?? {}))) {
    for (const [node, key] of targets(doc, path, arrayFilters)) {
      if (node[key] === undefined || node[key] === null || timeOf(value) > timeOf(node[key])) node[key] = copy(value);
    }
  }
  // A whole-document replacement (findByIdAndUpdate(id, { latestMessageData })).
  for (const [key, value] of Object.entries(plain(update))) {
    if (!key.startsWith("$")) doc[key] = copy(value);
  }
};

let tick = 0;
/** Strictly increasing times, so createdAt and updatedAt orderings are never ties. */
const now = () => new Date(Date.now() + tick++);

/** A mongoose-like query over `run`: chainable, awaitable, and lean. */
const chain = (run, calls) => {
  const state = { sort: null, skip: 0, limit: null };
  const result = () => {
    let rows = run();
    if (!Array.isArray(rows)) return copy(rows);
    if (state.sort) {
      const keys = Object.entries(state.sort);
      rows = [...rows].sort((a, b) => {
        for (const [key, direction] of keys) {
          const left = timeOf(a[key]);
          const right = timeOf(b[key]);
          if (left !== right) return (left < right ? -1 : 1) * direction;
        }
        return 0;
      });
    }
    rows = rows.slice(state.skip, state.limit === null ? undefined : state.skip + state.limit);
    return rows.map(copy);
  };
  const query = {
    sort: (sort) => ((state.sort = sort), query),
    skip: (n) => ((state.skip = n), query),
    limit: (n) => ((state.limit = n), query),
    select: () => query,
    session: () => query,
    lean: () => query,
    populate: (...args) => (calls.populate.push(args), query),
    then: (resolve, reject) => Promise.resolve().then(result).then(resolve, reject),
  };
  return query;
};

/** A duplicate key, shaped like the driver's. */
const duplicateKey = (keyPattern) => Object.assign(new Error("E11000 duplicate key error"), { code: 11000, keyPattern });

/**
 * Installs both collections. `seed` is { conversations, messages } as plain
 * rows. Returns the live rows, the calls, and `restore`.
 */
const installStore = (seed = {}) => {
  const db = {
    conversations: (seed.conversations ?? []).map((row) => plain(row)),
    messages: (seed.messages ?? []).map((row) => plain(row)),
  };
  const calls = { populate: [], writes: [] };

  const collection = (name, model, { unique } = {}) => {
    const rows = () => db[name];
    const insert = (doc) => {
      const row = plain({ createdAt: now(), updatedAt: now(), ...doc });
      if (!row._id) row._id = oid();
      if (unique) unique(rows(), row);
      db[name].push(row);
      return row;
    };
    const write = (kind, filter, update, options = {}) => {
      calls.writes.push({ collection: name, kind, filter: plain(filter), update: plain(update), options });
      const test = matches(filter);
      const found = kind === "updateMany" ? rows().filter(test) : rows().filter(test).slice(0, 1);
      let modified = 0;
      const befores = [];
      for (const row of found) {
        const before = copy(row);
        befores.push(before);
        applyUpdate(row, update, options);
        if (JSON.stringify(before) !== JSON.stringify(row)) {
          modified++;
          if (options.timestamps !== false) row.updatedAt = now();
        }
      }
      return { found, befores, modified };
    };
    return [
      stub(model, "find", (filter) => chain(() => rows().filter(matches(filter)), calls)),
      stub(model, "findOne", (filter) => chain(() => rows().find(matches(filter)) ?? null, calls)),
      stub(model, "findById", (id) => chain(() => rows().find((row) => row._id === String(id)) ?? null, calls)),
      stub(model, "countDocuments", async (filter) => rows().filter(matches(filter)).length),
      stub(model, "findOneAndUpdate", (filter, update, options = {}) =>
        chain(() => {
          const { found, befores } = write("findOneAndUpdate", filter, update, options);
          if (found.length === 0) return null;
          const after = options.returnDocument === "after" || options.new === true;
          return after ? found[0] : befores[0];
        }, calls)
      ),
      stub(model, "findByIdAndUpdate", (id, update, options = {}) =>
        chain(() => {
          const { found, befores } = write("findOneAndUpdate", { _id: String(id) }, update, options);
          if (found.length === 0) return null;
          return options.new ? found[0] : befores[0];
        }, calls)
      ),
      stub(model, "updateOne", async (filter, update, options = {}) => {
        const { found, modified } = write("updateOne", filter, update, options);
        return { acknowledged: true, matchedCount: found.length, modifiedCount: modified };
      }),
      stub(model, "updateMany", async (filter, update, options = {}) => {
        const { found, modified } = write("updateMany", filter, update, options);
        return { acknowledged: true, matchedCount: found.length, modifiedCount: modified };
      }),
      stub(model, "create", async (docs) => {
        const many = Array.isArray(docs);
        const made = (many ? docs : [docs]).map((doc) => {
          const row = insert(doc);
          return { ...copy(row), toObject: () => copy(row) };
        });
        return many ? made : made[0];
      }),
      stub(model, "deleteOne", async (filter) => {
        const index = rows().findIndex(matches(filter));
        if (index >= 0) db[name].splice(index, 1);
        return { acknowledged: true, deletedCount: index >= 0 ? 1 : 0 };
      }),
    ];
  };

  const restores = [
    ...collection("conversations", conversationModel, {
      // { organizationId: 1, candidateUserId: 1 }, unique where candidateUserId exists.
      unique: (rows, row) => {
        if (!row.candidateUserId) return;
        if (rows.some((other) => other.candidateUserId === row.candidateUserId && other.organizationId === row.organizationId)) {
          throw duplicateKey({ organizationId: 1, candidateUserId: 1 });
        }
      },
    }),
    ...collection("messages", messageModel),
    stub(conversationModel.prototype, "save", async () => assert.fail("a conversation must never be .save()d (CHAT-CONTRACT.md §1.1)")),
  ];

  return { db, calls, restore: () => restores.reverse().forEach((undo) => undo()) };
};

/**
 * seemuehub-backend, as axios.post sees it. `authorize(body)` decides each
 * authorize call (it may throw to be unreachable); opened and blocks are
 * recorded and answered. Every call is in `calls`; the pushes in `pushes`.
 */
const installBackend = ({ authorize, remainingToday = 49, blocked = true } = {}) => {
  const calls = [];
  const restore = stub(axios, "post", async (url, body, options) => {
    calls.push({ url, body, options });
    const path = new URL(url).pathname;
    if (path === "/api/v1/internal/org-chat/authorize") return { data: { success: true, data: authorize(body) } };
    if (path === "/api/v1/internal/org-chat/opened") return { data: { success: true, data: { remainingToday } } };
    if (path === "/api/v1/internal/org-chat/blocks") return { data: { success: true, data: { blocked } } };
    if (path === "/api/v1/internal/push/chat") return { data: { success: true, data: { sent: 1 } } };
    throw Object.assign(new Error("not found"), { response: { status: 404 } });
  });
  const of = (route) => calls.filter((call) => new URL(call.url).pathname === `/api/v1/internal/${route}`);
  return {
    calls,
    authorizations: () => of("org-chat/authorize").map((call) => call.body),
    opened: () => of("org-chat/opened").map((call) => call.body),
    blocks: () => of("org-chat/blocks").map((call) => call.body),
    pushes: () => of("push/chat").map((call) => call.body),
    restore,
  };
};

module.exports = { applyUpdate, installBackend, installStore, matches, oid, plain };
