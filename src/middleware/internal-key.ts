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
 * Fails closed: while no key is configured every call is refused (401,
 * `internal_key_unset` with `action: "refused"`). These routes used to stay
 * open until the key was set, so a deploy that lost the key opened them to
 * anyone. `body` is what a refusal answers, `{ code: "CHAT-401", message }`
 * unless the route's envelope differs.
 *
 * `readKey` is called per request so the configured key is always the current
 * one, and so tests can supply their own.
 */
export const requireInternalKey =
  (readKey: () => string | undefined, { body = messages.UNAUTHORIZED as object } = {}) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const path = req.originalUrl?.split("?")[0] ?? req.path;
    const expected = readKey();
    if (!expected) {
      console.warn(JSON.stringify({ msg: "internal_key_unset", path, action: "refused" }));
      res.status(401).json(body);
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
