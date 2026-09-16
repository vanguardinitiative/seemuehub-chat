"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const message_1 = require("../controllers/message/index.js");
const middleware_1 = require("../middleware/index.js");
const express_1 = require("express");
const messageRoute = (0, express_1.Router)();
messageRoute.get("/histories", middleware_1.checkAuthorizationMiddleware, message_1.getAllMessageHistory);
messageRoute.get("/", middleware_1.checkAuthorizationMiddleware, message_1.getAllMessage);
exports.default = messageRoute;
//# sourceMappingURL=message.js.map