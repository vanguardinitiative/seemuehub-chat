import { getAllMessage, getAllMessageHistory } from "@/controllers/message";
import { checkAuthorizationMiddleware } from "@/middleware";
import { IRouter, Router } from "express";
const messageRoute: IRouter = Router();

// Both of these returned message bodies to anyone who knew (or guessed) a
// conversation id, with no credential of any kind.
messageRoute.get("/histories", checkAuthorizationMiddleware, getAllMessageHistory);
messageRoute.get("/", checkAuthorizationMiddleware, getAllMessage);

export default messageRoute;
