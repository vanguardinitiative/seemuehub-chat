"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const conversation_1 = require("../controllers/conversation");
const middleware_1 = require("../middleware");
const express_1 = require("express");
const conversationRoute = (0, express_1.Router)();
conversationRoute.post("/private", conversation_1.createPrivateConversation);
conversationRoute.post("/group", conversation_1.createGroupConversation);
conversationRoute.get("/:id", conversation_1.getConversation);
conversationRoute.get("/", middleware_1.checkAuthorizationMiddleware, conversation_1.getAllConversions);
exports.default = conversationRoute;
//# sourceMappingURL=conversation.js.map