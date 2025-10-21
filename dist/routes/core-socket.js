"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const core_socket_1 = require("../controllers/core-socket");
const coreSocketRoute = (0, express_1.Router)();
coreSocketRoute.post("/payment", core_socket_1.coreSocketController);
exports.default = coreSocketRoute;
//# sourceMappingURL=core-socket.js.map