import { IRouter, Router } from "express";
import { coreSocketController } from "@/controllers/core-socket";
const coreSocketRoute: IRouter = Router();

coreSocketRoute.post("/payment", coreSocketController);

export default coreSocketRoute;
