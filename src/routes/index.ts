import { IRouter, Router } from "express";
import messageRoute from "./message";
import conversationRoute from "./conversation";
import messageStatusRoute from "./messageStatus";
import coreSocketRoute from "./core-socket";

const router: IRouter = Router();

router.use("/messages", messageRoute);
router.use("/conversations", conversationRoute);
router.use("/message-status", messageStatusRoute);
router.use("/core-socket", coreSocketRoute);

export default router;
