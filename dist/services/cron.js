"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cancelStalePendingConversations = cancelStalePendingConversations;
exports.scheduleDailyCancellation = scheduleDailyCancellation;
const conversation_1 = require("../models/conversation");
function getOneMonthAgo() {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - THIRTY_DAYS_MS);
}
async function cancelStalePendingConversations() {
    const cutoff = getOneMonthAgo();
    console.log("cutoff====>", cutoff);
    try {
        const result = await conversation_1.conversationModel.updateMany({
            orderStatus: conversation_1.OrderStatus.PENDING,
            createdAt: { $lt: cutoff },
        }, {
            $set: { orderStatus: conversation_1.OrderStatus.CANCELLED, isOrderActive: false },
        });
        console.log("result====>", result);
        console.log(`Cron: cancelStalePendingConversations -> matched=${result.matchedCount ?? result.n} modified=${result.modifiedCount ?? result.nModified} before=${cutoff.toISOString()}`);
    }
    catch (error) {
        console.error("Cron: cancelStalePendingConversations error:", error);
    }
}
function msUntilNext(hour, minute) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) {
        next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now.getTime();
}
function scheduleDailyCancellation(hourLocal = 2, minuteLocal = 0) {
    const initialDelay = msUntilNext(hourLocal, minuteLocal);
    console.log(`Cron: scheduling cancelStalePendingConversations first run in ${Math.round(initialDelay / 1000)}s, then every 24h at ${hourLocal.toString().padStart(2, "0")}:${minuteLocal.toString().padStart(2, "0")}`);
    setTimeout(async () => {
        await cancelStalePendingConversations();
        setInterval(cancelStalePendingConversations, 24 * 60 * 60 * 1000);
    }, initialDelay);
}
//# sourceMappingURL=cron.js.map