import {
  createGroupConversation,
  createPrivateConversation,
  getAllConversions,
  getConversation,
} from "@/controllers/conversation";
import { checkAuthorizationMiddleware } from "@/middleware";
import { IRouter, Router } from "express";
const conversationRoute: IRouter = Router();

// Every route that reads or resolves a conversation needs the caller's identity.
// `/:id` and `/private` used to have none at all, which meant anyone on the
// internet could read a conversation — and the populate on `/:id` hands back
// both participants' fullName, phone and email.
//
// `/group` is deliberately left alone: it creates the support group and fans out
// to staff rows with TAXI_*/EXPRESS_* roles, i.e. it belongs to the other
// product that shares this service, whose clients we cannot see.
conversationRoute.post("/private", checkAuthorizationMiddleware, createPrivateConversation);
conversationRoute.post("/group", createGroupConversation);
conversationRoute.get("/:id", checkAuthorizationMiddleware, getConversation);
conversationRoute.get("/", checkAuthorizationMiddleware, getAllConversions);

export default conversationRoute;
