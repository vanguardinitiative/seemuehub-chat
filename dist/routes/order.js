"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const order_1 = require("../controllers/order");
const express_1 = require("express");
const orderRoute = (0, express_1.Router)();
orderRoute.post("/", order_1.orderController);
exports.default = orderRoute;
//# sourceMappingURL=order.js.map