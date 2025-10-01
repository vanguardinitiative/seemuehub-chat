"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const zod_1 = require("zod");
const envSchema = zod_1.z.object({
    PORT: zod_1.z.string().default("3001"),
    MONGODB_URI: zod_1.z.string().min(1, "MongoDB URI is required"),
    REDIS_HOST: zod_1.z.string(),
    REDIS_PORT: zod_1.z.string(),
    REDIS_PASSWORD: zod_1.z.string(),
    CHAT_SERVICE_URL: zod_1.z.string().default("http://localhost:3001"),
    CORS_ORIGIN: zod_1.z.string().default("http://localhost:5173"),
    SOCKET_CORS_ORIGIN: zod_1.z.string().default("http://localhost:5173"),
});
exports.env = envSchema.parse(process.env);
//# sourceMappingURL=env.js.map