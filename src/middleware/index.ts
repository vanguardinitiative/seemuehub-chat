import { messages } from "@/config";
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface TokenData {
  id: string;
  fullName: string;
  status: string;
  role: string;
}

export const checkAuthorizationMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers["authorization"];
    if (token) {
      const accessToken: string = token.replace("Bearer ", "");
      const payloadData = jwt.verify(accessToken, process.env.JWT_SECRET_KEY as any);
      (req as any).user = payloadData;
    } else {
      res.status(401).json({
        code: messages.UNAUTHORIZED.code,
        message: messages.UNAUTHORIZED.message,
        detail: "Invalid signature",
      });
      return;
    }
    next();
  } catch (error) {
    console.log("error: ", error);
    console.log("error.name: ", (error as Error).name);
    if ((error as Error).name === "TokenExpiredError") {
      res.status(401).json({ code: messages.TOKEN_EXPIRED.code, message: messages.TOKEN_EXPIRED.message });
      return;
    }
    res
      .status(401)
      .json({ code: messages.UNAUTHORIZED.code, message: messages.UNAUTHORIZED.message, detail: "Invalid signature" });
    return;
  }
};
