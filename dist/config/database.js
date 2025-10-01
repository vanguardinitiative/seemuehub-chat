"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const env_1 = require("./env");
const connectDB = async () => {
    try {
        await mongoose_1.default.connect(env_1.env.MONGODB_URI);
        console.log("Database connected");
    }
    catch (error) {
        console.error("Database connection error:", error);
        process.exit(1);
    }
};
exports.default = connectDB;
//# sourceMappingURL=database.js.map