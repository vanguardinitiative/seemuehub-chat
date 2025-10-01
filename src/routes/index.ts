import { IRouter, Router } from "express";
import messageRoute from "./message";
import conversationRoute from "./conversation";
import messageStatusRoute from "./messageStatus";

const router: IRouter = Router();

router.use("/messages", messageRoute);
router.use("/conversations", conversationRoute);
router.use("/message-status", messageStatusRoute);

export default router;
