import { getAllMessage, getAllMessageHistory } from "@/controllers/message";
import { IRouter, Router } from "express";
const messageRoute: IRouter = Router();

messageRoute.get("/histories", getAllMessageHistory);
messageRoute.get("/", getAllMessage);

export default messageRoute;
