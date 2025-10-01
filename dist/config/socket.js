"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupSocketService = void 0;
const socket_io_1 = require("socket.io");
const redis_1 = require("./redis");
const message_1 = require("../controllers/message");
const setupSocketService = (server) => {
    const io = new socket_io_1.Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
        },
    });
    global.__installSubscriptions = () => (0, redis_1.subscribeToClient)(io);
    (0, redis_1.subscribeToClient)(io);
    io.on("connection", (socket) => {
        console.log("Frontend client connected: ", socket.id);
        socket.on("SETUP", (data) => {
            console.log("SETUP", data);
            redis_1.pub.publish("SETUP", JSON.stringify({ ...data, socketId: socket.id }));
        });
        socket.on("NEW_MESSAGE", (data) => {
            try {
                console.log("NEW_MESSAGE", data);
                (0, message_1.sendPrivateMessage)(socket, io, data);
            }
            catch (error) {
                console.error("Error handling NEW_MESSAGE:", error);
            }
        });
        socket.on("NEW_GROUP_MESSAGE", (data) => {
            try {
                console.log("NEW_GROUP_MESSAGE", data);
                (0, message_1.sendGroupMessage)(socket, io, data);
            }
            catch (error) {
                console.error("Error handling NEW_MESSAGE:", error);
            }
        });
        socket.on("disconnect", () => {
            redis_1.pub.publish("USER_OFFLINE", JSON.stringify({ socketId: socket.id }));
            console.log("Frontend client disconnected: ", socket.id);
        });
    });
};
exports.setupSocketService = setupSocketService;
//# sourceMappingURL=socket.js.map