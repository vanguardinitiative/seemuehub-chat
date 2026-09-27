import { messages } from "@/config";
import { pub } from "@/config/redis";
import { Request, Response } from "express";
import crypto from "crypto";
import { env } from "@/config/env";

/**
 * Whether the request carries the backend's shared key. Open when no key is
 * configured, so the key can be rolled out to both services in either order.
 */
const fromBackend = (req: Request): boolean => {
  const expected = env.CHAT_INTERNAL_KEY;
  if (!expected) return true;
  const presented = req.get("x-internal-key") ?? "";
  const a = crypto.createHash("sha256").update(presented).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
};

export const coreSocketController = async (req: Request, res: Response): Promise<void> => {
  try {
    // Anyone could post here and make a user's page announce a payment that
    // never happened.
    if (!fromBackend(req)) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    console.log("🔔 Payment received from backend", { id: req.body?._id, type: req.body?.type, status: req.body?.status });
    pub.publish("PAYMENT", JSON.stringify(req.body));
    res.status(200).json(messages.SUCCESSFULLY);
    return;
  } catch (error) {
    console.log(error);
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
    return;
  }
};
