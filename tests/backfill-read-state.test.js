/**
 * scripts/backfill-read-state.ts (worktrees/CHAT-CONTRACT.md §1.6), offline:
 * what it matches and what it writes. It never connects when required, only
 * when run (`node dist/scripts/backfill-read-state.js [--apply]`).
 */
require("./helpers/offline");

const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");

const { backfillFilter, backfillUpdate } = require("../dist/scripts/backfill-read-state.js");

const DAY = 24 * 60 * 60 * 1000;

test("requiring the script does not connect anywhere", () => {
  assert.strictEqual(mongoose.connection.readyState, 0);
});

test("the filter: a participant without a read mark, and an old latest message or a closed order", () => {
  const now = new Date("2026-10-02T00:00:00.000Z");
  const filter = backfillFilter(now);
  assert.deepStrictEqual(filter["latestMessageData.sendAt"], { $type: "date" }, "nothing to copy without a sendAt");
  // { lastReadAt: null } inside $elemMatch matches a missing field and a null one.
  assert.deepStrictEqual(filter.participants, { $elemMatch: { lastReadAt: null } });
  assert.deepStrictEqual(filter.$or, [
    { "latestMessageData.sendAt": { $lt: new Date(now.getTime() - 7 * DAY) } },
    { orderStatus: { $in: ["COMPLETED", "CANCELLED", "REFUNDED"] } },
  ]);
});

test("the update: one pipeline stage that fills only the missing read marks with latestMessageData.sendAt", () => {
  const update = backfillUpdate();
  assert.ok(Array.isArray(update), "a pipeline update: no mongoose, no timestamps, no updatedAt bump");
  assert.strictEqual(update.length, 1);
  assert.deepStrictEqual(Object.keys(update[0]), ["$set"]);
  assert.deepStrictEqual(Object.keys(update[0].$set), ["participants"], "nothing but participants is written");
  const { $map } = update[0].$set.participants;
  assert.strictEqual($map.input, "$participants");
  const [missing, filled, kept] = $map.in.$cond;
  assert.deepStrictEqual(missing, { $eq: [{ $ifNull: ["$$participant.lastReadAt", null] }, null] });
  assert.deepStrictEqual(filled, { $mergeObjects: ["$$participant", { lastReadAt: "$latestMessageData.sendAt" }] });
  assert.strictEqual(kept, "$$participant", "an existing read mark is kept, so re-running changes nothing");
});
