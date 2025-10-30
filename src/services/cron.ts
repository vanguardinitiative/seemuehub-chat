import { conversationModel, OrderStatus } from "@/models/conversation";

function getOneMonthAgo(): Date {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - THIRTY_DAYS_MS);
}

export async function cancelStalePendingConversations(): Promise<void> {
  const cutoff = getOneMonthAgo();

  console.log("cutoff====>", cutoff);
  try {
    const result = await conversationModel.updateMany(
      {
        orderStatus: OrderStatus.PENDING,
        createdAt: { $lt: cutoff },
      },
      {
        $set: { orderStatus: OrderStatus.CANCELLED, isOrderActive: false },
      }
    );
    console.log("result====>", result);
    console.log(
      `Cron: cancelStalePendingConversations -> matched=${result.matchedCount ?? (result as any).n} modified=${
        result.modifiedCount ?? (result as any).nModified
      } before=${cutoff.toISOString()}`
    );
  } catch (error) {
    console.error("Cron: cancelStalePendingConversations error:", error);
  }
}

function msUntilNext(hour: number, minute: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export function scheduleDailyCancellation(hourLocal = 2, minuteLocal = 0): void {
  const initialDelay = msUntilNext(hourLocal, minuteLocal);
  console.log(
    `Cron: scheduling cancelStalePendingConversations first run in ${Math.round(
      initialDelay / 1000
    )}s, then every 24h at ${hourLocal.toString().padStart(2, "0")}:${minuteLocal.toString().padStart(2, "0")}`
  );
  setTimeout(async () => {
    await cancelStalePendingConversations();
    setInterval(cancelStalePendingConversations, 24 * 60 * 60 * 1000);
  }, initialDelay);
}
// export function scheduleEveryMinuteCancellation(intervalMinutes = 1): void {
//   console.log(`Cron: scheduling cancelStalePendingConversations every ${intervalMinutes} minute(s)`);
//   // run once immediately for visibility
//   cancelStalePendingConversations().catch(console.error);
//   setInterval(cancelStalePendingConversations, intervalMinutes * 60 * 1000);
// }
