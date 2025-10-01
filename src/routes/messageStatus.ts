import { updateReadStatus } from "@/controllers/messageStatus";
import { checkAuthorizationMiddleware } from "@/middleware";
import { IRouter, Router } from "express";
const messageStatusRoute: IRouter = Router();

messageStatusRoute.put("/read", checkAuthorizationMiddleware, updateReadStatus);

export default messageStatusRoute;
