"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const message_1 = __importDefault(require("./message"));
const conversation_1 = __importDefault(require("./conversation"));
const messageStatus_1 = __importDefault(require("./messageStatus"));
const core_socket_1 = __importDefault(require("./core-socket"));
const router = (0, express_1.Router)();
router.use("/messages", message_1.default);
router.use("/conversations", conversation_1.default);
router.use("/message-status", messageStatus_1.default);
router.use("/core-socket", core_socket_1.default);
exports.default = router;
//# sourceMappingURL=index.js.map