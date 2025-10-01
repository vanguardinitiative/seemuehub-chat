import {
  createGroupConversation,
  createPrivateConversation,
  getAllConversions,
  getConversation,
} from "@/controllers/conversation";
import { checkAuthorizationMiddleware } from "@/middleware";
import { IRouter, Router } from "express";
const conversationRoute: IRouter = Router();

conversationRoute.post("/private", createPrivateConversation);
conversationRoute.post("/group", createGroupConversation);
conversationRoute.get("/:id", getConversation);
conversationRoute.get("/", checkAuthorizationMiddleware, getAllConversions);

export default conversationRoute;
