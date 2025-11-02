import { orderController } from "@/controllers/order";
import { IRouter, Router } from "express";
const orderRoute: IRouter = Router();

orderRoute.post("/", orderController);

export default orderRoute;
