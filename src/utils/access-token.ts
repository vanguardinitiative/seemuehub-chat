import jwt, { type JwtPayload } from "jsonwebtoken";
import { Types } from "mongoose";

/**
 * The one place an access token is checked, for REST
 * (`checkAuthorizationMiddleware`) and the socket handshake alike, so the two
 * cannot disagree about who a caller is.
 *
 * Tokens are minted by seemuehub-backend: `jwt.sign({ userId }, JWT_SECRET,
 * { expiresIn: "1d" })`, HS256, with the same secret this service reads as
 * `JWT_SECRET_KEY`. The backend signs its 5-day refresh token with that same
 * secret as `{ userId, type: "refresh" }`, and refuses it as an access token;
 * so do we, or a refresh token would work here as a 5-day access token.
 */

export type AccessTokenErrorCode = "TOKEN_EXPIRED" | "TOKEN_INVALID";

export class AccessTokenError extends Error {
  readonly code: AccessTokenErrorCode;

  constructor(code: AccessTokenErrorCode) {
    super(code);
    this.name = "AccessTokenError";
    this.code = code;
  }
}

export interface VerifiedAccessToken {
  /** The caller, from the token's `userId` claim. */
  userId: string;
  payload: JwtPayload;
  /** The token's `exp`, in seconds since the epoch; null when it carries none. */
  expiresAt: number | null;
}

/** "Bearer abc", "bearer abc" or "abc" → "abc"; anything empty → null. */
export const stripBearer = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const token = raw.trim().replace(/^Bearer(?:\s+|$)/i, "").trim();
  return token.length > 0 ? token : null;
};

/**
 * Verifies a raw or `Bearer`-prefixed access token and returns its user.
 *
 * Throws `AccessTokenError("TOKEN_EXPIRED")` for a genuinely signed token that
 * has run out (the client should refresh and retry), and
 * `AccessTokenError("TOKEN_INVALID")` for everything else. jsonwebtoken checks
 * the signature before the expiry, so a forged token never reads as expired.
 */
export const verifyAccessToken = (
  raw: unknown,
  secret: string | undefined = process.env.JWT_SECRET_KEY
): VerifiedAccessToken => {
  const token = stripBearer(raw);
  // No secret configured must fail closed: jwt.verify would throw anyway, but
  // say so here rather than rely on it.
  if (!token || !secret) throw new AccessTokenError("TOKEN_INVALID");

  let decoded: string | JwtPayload;
  try {
    decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) throw new AccessTokenError("TOKEN_EXPIRED");
    throw new AccessTokenError("TOKEN_INVALID");
  }

  if (typeof decoded !== "object" || decoded === null) throw new AccessTokenError("TOKEN_INVALID");
  if (decoded.type === "refresh") throw new AccessTokenError("TOKEN_INVALID");

  // Same rule as `userIdOf` in utils/conversation-access.ts.
  const userId = decoded.userId;
  if (typeof userId !== "string" || !Types.ObjectId.isValid(userId)) {
    throw new AccessTokenError("TOKEN_INVALID");
  }

  return { userId, payload: decoded, expiresAt: typeof decoded.exp === "number" ? decoded.exp : null };
};
