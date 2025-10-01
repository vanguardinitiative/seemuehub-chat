"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const messageStatus_1 = require("../controllers/messageStatus");
const middleware_1 = require("../middleware");
const express_1 = require("express");
const messageStatusRoute = (0, express_1.Router)();
messageStatusRoute.put("/read", middleware_1.checkAuthorizationMiddleware, messageStatus_1.updateReadStatus);
exports.default = messageStatusRoute;
//# sourceMappingURL=messageStatus.js.map