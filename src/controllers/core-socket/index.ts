import { messages } from "@/config";
import { pub } from "@/config/redis";
import { Request, Response } from "express";

export const coreSocketController = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log("🔔 Payment received from backend", req.body);
    pub.publish("PAYMENT", JSON.stringify(req.body));
    res.status(200).json(messages.SUCCESSFULLY);
    return;
  } catch (error) {
    console.log(error);
    res.status(500).json(messages.INTERNAL_SERVER_ERROR);
    return;
  }
};
