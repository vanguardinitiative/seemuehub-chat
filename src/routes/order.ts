import { orderController } from "@/controllers/order";
import { env } from "@/config/env";
import { requireInternalKey } from "@/middleware/internal-key";
import { IRouter, Router } from "express";
const orderRoute: IRouter = Router();

// seemuehub-backend only (conversation.service updateOrderStep). Whatever is
// posted here is stored as a message in the named conversation, as the named
// sender, and pushed to its participants - it had no authentication at all.
orderRoute.post("/", requireInternalKey(() => env.CHAT_INTERNAL_KEY), orderController);

export default orderRoute;
