"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.coreSocketController = void 0;
const config_1 = require("../../config");
const redis_1 = require("../../config/redis");
const coreSocketController = async (req, res) => {
    try {
        console.log("🔔 Payment received from backend", req.body);
        redis_1.pub.publish("PAYMENT", JSON.stringify(req.body));
        res.status(200).json(config_1.messages.SUCCESSFULLY);
        return;
    }
    catch (error) {
        console.log(error);
        res.status(500).json(config_1.messages.INTERNAL_SERVER_ERROR);
        return;
    }
};
exports.coreSocketController = coreSocketController;
//# sourceMappingURL=index.js.map