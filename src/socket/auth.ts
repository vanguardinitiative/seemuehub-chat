import type { Socket } from "socket.io";
import { AccessTokenError, verifyAccessToken } from "@/utils/access-token";

/**
 * Who is on the other end of a socket.
 *
 * Clients connect with `io(url, { auth: { token } })`, the same access token
 * they send REST as `Authorization: Bearer …`. The handshake middleware below
 * verifies it once and records the user on `socket.data.userId`; every handler
 * takes the caller from there and never from an event payload.
 *
 * A socket that connects with no token at all is "legacy": every client
 * shipped before this change, and a signed-out visitor on /donate.
 * SOCKET_AUTH_MODE decides what it may do:
 *
 * - permissive (default): what it always could, trusting the userId/senderId
 *   in its payloads, with a `legacy_socket` log line per event so the
 *   remaining legacy clients can be counted.
 * - enforce: it may stay connected and receive broadcasts, but SETUP and
 *   message sends are answered with ERROR { code: "AUTH_REQUIRED" }.
 */

export type SocketAuthMode = "permissive" | "enforce";

/** What this service keeps on `socket.data`. */
export interface SocketData {
  /** The verified caller. Only the handshake sets it. */
  userId?: string;
  /** The handshake token's `exp` (seconds since the epoch). */
  tokenExpiresAt?: number | null;
  /** The userId room this socket asked to join at SETUP (verified, or claimed by a legacy socket). */
  roomUserId?: string;
  /** Users who share a conversation with roomUserId: who hears this socket's online/offline. */
  partners?: string[];
  /** When this socket's recent REACT_MESSAGEs were accepted, for the rate limit. */
  reactionTimes?: number[];
}

export const dataOf = (socket: Socket): SocketData => socket.data as SocketData;

export type SocketErrorCode =
  | "AUTH_REQUIRED"
  | "TOKEN_EXPIRED"
  | "NOT_PARTICIPANT"
  | "INVALID_PAYLOAD"
  | "MESSAGE_SEND_FAILED"
  | "RATE_LIMITED";

const ERROR_MESSAGES: Record<SocketErrorCode, string> = {
  AUTH_REQUIRED: "Connect with auth: { token } to use this event",
  TOKEN_EXPIRED: "Access token expired; refresh it and reconnect",
  NOT_PARTICIPANT: "You are not a participant of this conversation",
  INVALID_PAYLOAD: "Invalid payload",
  MESSAGE_SEND_FAILED: "Failed to send message",
  RATE_LIMITED: "Too many events; try again shortly",
};

/** Every refusal goes out as one `ERROR` event of this shape. */
export const refuse = (
  socket: Socket,
  event: string,
  code: SocketErrorCode,
  extra: Record<string, unknown> = {}
): void => {
  socket.emit("ERROR", { code, message: ERROR_MESSAGES[code], event, ...extra });
};

/** One JSON line per event, ids only. */
export const logEvent = (fields: Record<string, unknown>): void => {
  console.log(JSON.stringify(fields));
};

const origin = (socket: Socket): string | null => {
  const value = socket.handshake.headers?.origin;
  return typeof value === "string" ? value : null;
};

/** Absent means not sent at all: undefined, null, or an empty string. */
const isAbsent = (raw: unknown): boolean =>
  raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");

/**
 * `io.use` middleware. A present but bad token refuses the connection, and the
 * client sees it as `connect_error` with `err.message` and `err.data.code` set
 * to TOKEN_EXPIRED (refresh, then reconnect) or TOKEN_INVALID. A missing token
 * lets the socket in as legacy.
 */
export const socketAuthMiddleware = (socket: Socket, next: (err?: Error) => void): void => {
  const raw = socket.handshake.auth?.token;
  if (isAbsent(raw)) {
    next();
    return;
  }
  try {
    const { userId, expiresAt } = verifyAccessToken(raw);
    const data = dataOf(socket);
    data.userId = userId;
    data.tokenExpiresAt = expiresAt;
    next();
  } catch (error) {
    const code = error instanceof AccessTokenError ? error.code : "TOKEN_INVALID";
    logEvent({ msg: "socket_auth_refused", code, origin: origin(socket) });
    next(Object.assign(new Error(code), { data: { code } }));
  }
};

export type Actor = { kind: "verified"; userId: string } | { kind: "legacy" };

/**
 * The caller of `event`, or null once the event has been refused (an ERROR has
 * already gone to the client, and the handler must do nothing more).
 *
 * `claimedUserId` is only what a legacy payload says about itself, and is only
 * ever logged.
 */
export const actorFor = (
  socket: Socket,
  event: string,
  mode: SocketAuthMode,
  claimedUserId: unknown = undefined,
  now: () => number = Date.now
): Actor | null => {
  const data = dataOf(socket);

  if (data.userId) {
    // The handshake is the only place a token is read, so without this a
    // connection opened a minute before expiry would keep its authority for
    // as long as it stayed up.
    if (typeof data.tokenExpiresAt === "number" && data.tokenExpiresAt * 1000 <= now()) {
      refuse(socket, event, "TOKEN_EXPIRED");
      return null;
    }
    return { kind: "verified", userId: data.userId };
  }

  const allowed = mode !== "enforce";
  logEvent({
    msg: "legacy_socket",
    event,
    mode,
    action: allowed ? "allowed" : "refused",
    socketId: socket.id,
    claimedUserId: typeof claimedUserId === "string" && claimedUserId ? claimedUserId : null,
    origin: origin(socket),
  });
  if (!allowed) {
    refuse(socket, event, "AUTH_REQUIRED");
    return null;
  }
  return { kind: "legacy" };
};

/**
 * `actorFor` for the events only authenticated clients have (REACT_MESSAGE,
 * TYPING). Their payloads carry no claimed identity, so there is nothing a
 * legacy socket could be trusted with: it is refused with AUTH_REQUIRED in
 * either mode (and logged as `legacy_socket` with `"action":"refused"`). No
 * client that predates authenticated sockets sends these events.
 */
export const verifiedActorFor = (
  socket: Socket,
  event: string,
  mode: SocketAuthMode,
  now: () => number = Date.now
): { kind: "verified"; userId: string } | null => {
  if (!dataOf(socket).userId) {
    logEvent({ msg: "legacy_socket", event, mode, action: "refused", socketId: socket.id, claimedUserId: null, origin: origin(socket) });
    refuse(socket, event, "AUTH_REQUIRED");
    return null;
  }
  const actor = actorFor(socket, event, mode, undefined, now);
  return actor && actor.kind === "verified" ? actor : null;
};

/** Logs a tokenless connection; the event handlers log (and in enforce, refuse) what it then tries. */
export const logLegacyConnection = (socket: Socket, mode: SocketAuthMode): void => {
  if (dataOf(socket).userId) return;
  logEvent({ msg: "legacy_socket", event: "connect", mode, action: "allowed", socketId: socket.id, origin: origin(socket) });
};
