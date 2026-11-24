import type { Socket } from "socket.io";

/**
 * The one exception for sockets without a token (README, "Payments and
 * anonymous donations"): the signed-out donate page may follow the outcome of
 * the one donation it just made, with FOLLOW_DONATION { referenceId }, and
 * hear its PAYMENT event in that donation's room. Nothing else is opened to
 * it: SETUP and every send stay refused in enforce mode (socket/auth.ts).
 *
 * The rules live here, free of Mongo and socket.io's server, so the tests can
 * drive them; socket/handlers.ts applies them and services/donation-payments.ts
 * reads the payment.
 */

/** The fields of a backend payment the follow check reads. */
export interface DonationPayment {
  userId?: unknown;
  type?: unknown;
  status?: unknown;
  createdAt?: unknown;
}

/**
 * How long after a donation is created its page may start following it: 15
 * minutes, long enough to scan the QR and pay, short enough that old donation
 * ids are worth nothing. A socket that joined in time stays in the room.
 */
export const DONATION_FOLLOW_WINDOW_MS = 15 * 60_000;

/**
 * The statuses in which a donation can still be paid. FAILED is one: the bank
 * reports a failed attempt and the payer may try the same QR again.
 */
const FOLLOWABLE_STATUSES = new Set(["PENDING", "PROCESSING", "FAILED"]);

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** The room an anonymous donation's outcome goes to; null for anything that is not an id. */
export const donationRoomOf = (referenceId: unknown): string | null =>
  typeof referenceId === "string" && OBJECT_ID.test(referenceId) ? `donation:${referenceId.toLowerCase()}` : null;

export type FollowRefusal = "NOT_FOUND" | "NOT_DONATION" | "SIGNED_IN_DONATION" | "NOT_PENDING" | "EXPIRED";

/**
 * Why this payment may not be followed, or null when it may: it must be a
 * donation, made signed out (a signed-in donor hears it in their own room),
 * still payable, and created within DONATION_FOLLOW_WINDOW_MS.
 */
export const followRefusal = (payment: DonationPayment | null, now: number): FollowRefusal | null => {
  if (!payment) return "NOT_FOUND";
  if (payment.type !== "DONATE") return "NOT_DONATION";
  if (payment.userId !== undefined && payment.userId !== null && String(payment.userId) !== "") return "SIGNED_IN_DONATION";
  if (typeof payment.status !== "string" || !FOLLOWABLE_STATUSES.has(payment.status)) return "NOT_PENDING";
  const createdAt = payment.createdAt instanceof Date ? payment.createdAt.getTime() : Date.parse(String(payment.createdAt));
  if (!Number.isFinite(createdAt) || now - createdAt > DONATION_FOLLOW_WINDOW_MS) return "EXPIRED";
  return null;
};

export interface RateRule {
  limit: number;
  windowMs: number;
}

/**
 * Per client address, for sockets without a token only: handshakes (a
 * signed-out donate page opens one), and FOLLOW_DONATION attempts, refused
 * ones included. Signed-in sockets are never counted. In memory, per instance.
 */
export const ANONYMOUS_LIMITS: { connections: RateRule; follows: RateRule } = {
  connections: { limit: 30, windowMs: 60_000 },
  follows: { limit: 10, windowMs: 60_000 },
};

/**
 * A fixed-window counter per key: `allow(key, now)` counts one and says
 * whether that one is within the limit. At most `maxKeys` windows are kept;
 * stale ones go first, then the oldest.
 */
export const createRateLimiter = ({ limit, windowMs }: RateRule, maxKeys = 10_000) => {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string, now: number): boolean => {
    let entry = windows.get(key);
    if (!entry || now - entry.start >= windowMs) {
      windows.delete(key);
      if (windows.size >= maxKeys) {
        for (const [k, e] of windows) if (now - e.start >= windowMs) windows.delete(k);
        while (windows.size >= maxKeys) {
          const oldest = windows.keys().next().value;
          if (oldest === undefined) break;
          windows.delete(oldest);
        }
      }
      entry = { start: now, count: 0 };
      windows.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= limit;
  };
};

const headerOf = (socket: Socket, name: string): string | undefined => {
  const value = socket.handshake.headers?.[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim() !== "" ? first.trim() : undefined;
};

/**
 * Where a socket connected from, in the order the backend and the admin audit
 * (middleware/admin.ts) read it: the CDN's client header, then the proxies',
 * then the peer address.
 */
export const clientAddressOf = (socket: Socket): string =>
  (
    headerOf(socket, "cf-connecting-ip") ??
    headerOf(socket, "x-forwarded-for")?.split(",")[0]?.trim() ??
    headerOf(socket, "x-real-ip") ??
    socket.handshake.address ??
    "unknown"
  ).slice(0, 64);
