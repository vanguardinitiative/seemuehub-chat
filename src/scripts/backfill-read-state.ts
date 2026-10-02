/**
 * Backfill `participants[].lastReadAt` (worktrees/CHAT-CONTRACT.md §1.6).
 *
 *   node dist/scripts/backfill-read-state.js            # dry run: counts and 5 sample ids
 *   node dist/scripts/backfill-read-state.js --apply    # writes (the owner approves this)
 *
 * Before read state lived on the participants, private reads were never
 * recorded, so every conversation would show as unread the moment the new
 * rule ships. This marks the ones nobody is waiting on as read: each
 * participant without a `lastReadAt` gets `lastReadAt = latestMessageData.sendAt`
 * when that message is older than 7 days, or the order is COMPLETED,
 * CANCELLED or REFUNDED. Recent messages in active chats stay unread until
 * they are opened.
 *
 * - One driver `updateMany` with an aggregation-pipeline update, so mongoose
 *   timestamps never run and `updatedAt` (the list's sort key) is untouched.
 * - Idempotent: a participant who already has a `lastReadAt` keeps it, and a
 *   conversation with none missing does not match. Safe to re-run.
 * - Connects exactly like the service (config/database.ts, MONGODB_URI from
 *   config/env.ts), so run it where the service runs, e.g.
 *   `docker exec <chat container> node dist/scripts/backfill-read-state.js`.
 */
import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "@/config/database";
import { conversationModel, OrderStatus } from "@/models/conversation";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CLOSED_ORDER_STATUSES = [OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.REFUNDED];
const SAMPLE_SIZE = 5;

/** A participant entry without a read mark: `lastReadAt` missing or null. */
const MISSING_READ_MARK = { $elemMatch: { lastReadAt: null } };

/** Conversations with a participant to fill, and whose latest message is old or whose order is closed. */
export const backfillFilter = (now: Date) => {
  const cutoff = new Date(now.getTime() - SEVEN_DAYS_MS);
  return {
    "latestMessageData.sendAt": { $type: "date" },
    participants: MISSING_READ_MARK,
    $or: [{ "latestMessageData.sendAt": { $lt: cutoff } }, { orderStatus: { $in: CLOSED_ORDER_STATUSES } }],
  };
};

/** Each participant without a read mark gets the latest message's sendAt; the others are left as they are. */
export const backfillUpdate = () => [
  {
    $set: {
      participants: {
        $map: {
          input: "$participants",
          as: "participant",
          in: {
            $cond: [
              { $eq: [{ $ifNull: ["$$participant.lastReadAt", null] }, null] },
              { $mergeObjects: ["$$participant", { lastReadAt: "$latestMessageData.sendAt" }] },
              "$$participant",
            ],
          },
        },
      },
    },
  },
];

const describeTarget = (): string => {
  const { host, port, name } = mongoose.connection;
  return `${name || "?"} on ${host || "?"}${port ? `:${port}` : ""}`;
};

const main = async (): Promise<void> => {
  const apply = process.argv.includes("--apply");
  const now = new Date();
  const filter = backfillFilter(now);
  const collection = conversationModel.collection;

  await connectDB();
  console.log(`Database: ${describeTarget()}`);
  console.log(`Mode: ${apply ? "APPLY (writes)" : "dry run (no writes; pass --apply to write)"}`);

  const cutoff = new Date(now.getTime() - SEVEN_DAYS_MS);
  const [summary] = await collection
    .aggregate<{ conversations: number; participants: number; olderThan7Days: number; closedOrder: number }>([
      { $match: filter },
      {
        $group: {
          _id: null,
          conversations: { $sum: 1 },
          participants: {
            $sum: {
              $size: {
                $filter: {
                  input: "$participants",
                  as: "participant",
                  cond: { $eq: [{ $ifNull: ["$$participant.lastReadAt", null] }, null] },
                },
              },
            },
          },
          olderThan7Days: { $sum: { $cond: [{ $lt: ["$latestMessageData.sendAt", cutoff] }, 1, 0] } },
          closedOrder: { $sum: { $cond: [{ $in: ["$orderStatus", CLOSED_ORDER_STATUSES] }, 1, 0] } },
        },
      },
    ])
    .toArray();
  const leftUnread = await collection.countDocuments({
    participants: MISSING_READ_MARK,
    $nor: [filter],
  });
  const samples = await collection.find(filter, { projection: { _id: 1 } }).limit(SAMPLE_SIZE).toArray();

  console.log(`Conversations to backfill: ${summary?.conversations ?? 0}`);
  console.log(`  latest message older than 7 days: ${summary?.olderThan7Days ?? 0}`);
  console.log(`  order ${CLOSED_ORDER_STATUSES.join("/")}: ${summary?.closedOrder ?? 0} (a conversation can be both)`);
  console.log(`Participants to give a lastReadAt: ${summary?.participants ?? 0}`);
  console.log(`Conversations left alone (recent and active, or no latest sendAt): ${leftUnread}`);
  console.log(`Sample ids: ${samples.map((doc) => String(doc._id)).join(", ") || "(none)"}`);

  if (!apply) return;

  const result = await collection.updateMany(filter, backfillUpdate());
  console.log(`Applied: matched ${result.matchedCount}, modified ${result.modifiedCount}`);
};

// Only when run as a script, so the tests can require the filter and update.
if (require.main === module) {
  main()
    .then(() => mongoose.disconnect())
    .catch(async (error) => {
      console.error("Backfill failed:", error);
      await mongoose.disconnect().catch(() => undefined);
      process.exitCode = 1;
    });
}
