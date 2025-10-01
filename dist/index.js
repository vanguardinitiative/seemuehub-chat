"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const dotenv_1 = __importDefault(require("dotenv"));
const cors_1 = __importDefault(require("cors"));
const database_1 = __importDefault(require("./config/database"));
const socket_1 = require("./config/socket");
const routes_1 = __importDefault(require("./routes"));
dotenv_1.default.config();
(0, database_1.default)();
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, cors_1.default)());
app.use("/v1/api", routes_1.default);
app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok" });
});
const port = process.env.PORT || 8181;
console.log("Server is starting...");
const server = http_1.default.createServer(app);
(0, socket_1.setupSocketService)(server);
server.listen(port, () => {
    console.log(`Socket service running on port ${port}`);
});
//# sourceMappingURL=index.js.map