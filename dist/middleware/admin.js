"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAdminMiddleware = void 0;
const mongoose_1 = require("mongoose");
const config_1 = require("../config/index.js");
const user_1 = require("../models/user.js");
const requireAdminMiddleware = async (req, res, next) => {
    try {
        const userId = req.user?.userId;
        if (typeof userId !== "string" || !mongoose_1.Types.ObjectId.isValid(userId)) {
            res.status(401).json(config_1.messages.UNAUTHORIZED);
            return;
        }
        const user = await user_1.userModel.findById(userId).select("role").lean();
        if (!user || user.role !== user_1.UserRole.ADMIN) {
            console.warn("[access] admin oversight refused", { userId });
            res.status(403).json(config_1.messages.FORBIDDEN);
            return;
        }
        next();
    }
    catch (error) {
        res.status(500).json(config_1.messages.INTERNAL_SERVER_ERROR);
    }
};
exports.requireAdminMiddleware = requireAdminMiddleware;
//# sourceMappingURL=admin.js.map