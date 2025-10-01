"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkAuthorizationMiddleware = void 0;
const config_1 = require("../config");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const checkAuthorizationMiddleware = async (req, res, next) => {
    try {
        const token = req.headers["authorization"];
        if (token) {
            const accessToken = token.replace("Bearer ", "");
            const payloadData = jsonwebtoken_1.default.verify(accessToken, process.env.JWT_SECRET_KEY);
            req.user = payloadData;
        }
        else {
            res.status(401).json({
                code: config_1.messages.UNAUTHORIZED.code,
                message: config_1.messages.UNAUTHORIZED.message,
                detail: "Invalid signature",
            });
            return;
        }
        next();
    }
    catch (error) {
        console.log("error: ", error);
        console.log("error.name: ", error.name);
        if (error.name === "TokenExpiredError") {
            res.status(401).json({ code: config_1.messages.TOKEN_EXPIRED.code, message: config_1.messages.TOKEN_EXPIRED.message });
            return;
        }
        res
            .status(401)
            .json({ code: config_1.messages.UNAUTHORIZED.code, message: config_1.messages.UNAUTHORIZED.message, detail: "Invalid signature" });
        return;
    }
};
exports.checkAuthorizationMiddleware = checkAuthorizationMiddleware;
//# sourceMappingURL=index.js.map