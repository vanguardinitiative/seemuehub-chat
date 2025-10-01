"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const message_1 = require("../controllers/message");
const express_1 = require("express");
const messageRoute = (0, express_1.Router)();
messageRoute.get("/histories", message_1.getAllMessageHistory);
messageRoute.get("/", message_1.getAllMessage);
exports.default = messageRoute;
//# sourceMappingURL=message.js.map