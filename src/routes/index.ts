import { IRouter, Router } from "express";
import messageRoute from "./message";
import conversationRoute from "./conversation";
import messageStatusRoute from "./messageStatus";
import coreSocketRoute from "./core-socket";
import orderRoute from "./order";

const router: IRouter = Router();

router.use("/messages", messageRoute);
router.use("/conversations", conversationRoute);
router.use("/message-status", messageStatusRoute);
router.use("/core-socket", coreSocketRoute);
router.use("/orders", orderRoute);

export default router;
