"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const conversation_1 = require("../controllers/conversation/index.js");
const middleware_1 = require("../middleware/index.js");
const admin_1 = require("../middleware/admin.js");
const admin_2 = require("../controllers/conversation/admin.js");
const express_1 = require("express");
const conversationRoute = (0, express_1.Router)();
conversationRoute.post("/private", middleware_1.checkAuthorizationMiddleware, conversation_1.createPrivateConversation);
conversationRoute.post("/group", conversation_1.createGroupConversation);
conversationRoute.get("/admin", middleware_1.checkAuthorizationMiddleware, admin_1.requireAdminMiddleware, admin_2.getAllConversationsAdmin);
conversationRoute.get("/:id", middleware_1.checkAuthorizationMiddleware, conversation_1.getConversation);
conversationRoute.get("/", middleware_1.checkAuthorizationMiddleware, conversation_1.getAllConversions);
exports.default = conversationRoute;
//# sourceMappingURL=conversation.js.map