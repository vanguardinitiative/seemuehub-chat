import { IRouter, Router } from "express";
import { coreSocketController } from "@/controllers/core-socket";
import { env } from "@/config/env";
import { requireInternalKey } from "@/middleware/internal-key";
const coreSocketRoute: IRouter = Router();

// seemuehub-backend only (the IB Bank callback). Anyone could post here and
// make a user's page announce a payment that never happened.
coreSocketRoute.post("/payment", requireInternalKey(() => env.CHAT_INTERNAL_KEY), coreSocketController);

export default coreSocketRoute;
