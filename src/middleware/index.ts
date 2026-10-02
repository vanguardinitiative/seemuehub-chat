import { messages } from "@/config";

/**
 * The 401 bodies. `errors.code` (UNAUTHORIZED, TOKEN_EXPIRED) is additive,
 * for the clients that branch on it as the organization routes answer;
 * `code`, `message` and `detail` are what they always were.
 */
const unauthorizedBody = {
  code: messages.UNAUTHORIZED.code,
  message: messages.UNAUTHORIZED.message,
  detail: "Invalid signature",
  errors: { code: "UNAUTHORIZED", message: messages.UNAUTHORIZED.message },
};
const expiredBody = {
  code: messages.TOKEN_EXPIRED.code,
  message: messages.TOKEN_EXPIRED.message,
  errors: { code: "TOKEN_EXPIRED", message: messages.TOKEN_EXPIRED.message },
};
import { Request, Response, NextFunction } from "express";
import { AccessTokenError, verifyAccessToken } from "@/utils/access-token";

export interface TokenData {
  id: string;
  fullName: string;
  status: string;
  role: string;
}

/**
 * Puts the verified token payload on `req.user`. Handlers read the caller
 * through `userIdOf(req)`, i.e. the `userId` claim.
 *
 * Verification is `verifyAccessToken`, shared with the socket handshake. Beyond
 * what this middleware used to check, that also refuses the backend's refresh
 * token (`type: "refresh"`, 5 days) and a token without a usable `userId`;
 * neither is anything a client should be sending here.
 */
export const checkAuthorizationMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers["authorization"];
  if (!header) {
    res.status(401).json(unauthorizedBody);
    return;
  }

  try {
    (req as any).user = verifyAccessToken(header).payload;
  } catch (error) {
    const code = error instanceof AccessTokenError ? error.code : "TOKEN_INVALID";
    if (code === "TOKEN_EXPIRED") {
      res.status(401).json(expiredBody);
      return;
    }
    console.warn("[auth] token refused", { code, path: req.path });
    res.status(401).json(unauthorizedBody);
    return;
  }

  next();
};
