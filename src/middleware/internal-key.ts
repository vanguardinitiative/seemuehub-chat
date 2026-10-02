import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { messages } from "@/config";

/**
 * Guards the routes only seemuehub-backend may call: POST /orders (an order
 * step, which becomes a message in the order's conversation), POST
 * /core-socket/payment (a payment for the payer's screen) and POST
 * /agent-messages (a Seemue AI card in a chat). The backend sends the shared
 * CHAT_INTERNAL_KEY as X-Internal-Key.
 *
 * While no key is configured the route stays open, as it always was, and every
 * call logs `internal_key_unset`: that is what lets this deploy before the
 * backend sends the header. Setting CHAT_INTERNAL_KEY is what turns the check
 * on. Rollout (README): backend first, then the key on the backend, then the
 * key here.
 *
 * Routes that never existed without the key pass `failClosed`: while no key
 * is configured they refuse every call (401, `internal_key_unset` with
 * `action: "refused"`) instead of staying open. POST /agent-messages is one.
 * `body` is what a refusal answers, `{ code: "CHAT-401", message }` unless
 * the route's envelope differs.
 *
 * `readKey` is called per request so the configured key is always the current
 * one, and so tests can supply their own.
 */
export const requireInternalKey =
  (readKey: () => string | undefined, { failClosed = false, body = messages.UNAUTHORIZED as object } = {}) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const path = req.originalUrl?.split("?")[0] ?? req.path;
    const expected = readKey();
    if (!expected) {
      console.warn(JSON.stringify({ msg: "internal_key_unset", path, action: failClosed ? "refused" : "allowed" }));
      if (failClosed) {
        res.status(401).json(body);
        return;
      }
      next();
      return;
    }

    const presented = req.get("x-internal-key") ?? "";
    if (!presented || !internalKeyMatches(presented, expected)) {
      console.warn(JSON.stringify({ msg: "internal_key_refused", path, presented: presented ? "wrong" : "none" }));
      res.status(401).json(body);
      return;
    }

    next();
  };

/**
 * Timing-safe: both sides are hashed first, so the comparison is always 32
 * bytes against 32 and leaks neither where nor whether-by-length they differ.
 */
export const internalKeyMatches = (presented: string, expected: string): boolean =>
  crypto.timingSafeEqual(
    crypto.createHash("sha256").update(presented).digest(),
    crypto.createHash("sha256").update(expected).digest()
  );
