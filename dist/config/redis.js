"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscribeToClient = exports.sub = exports.pub = void 0;
const redis_1 = require("redis");
const user_1 = require("../models/user");
const options = {
    socket: {
        port: 6379,
        host: process.env.REDIS_HOST,
    },
    family: 4,
    database: 0,
};
console.log("Redis configuration:", options);
const pub = (0, redis_1.createClient)(options);
exports.pub = pub;
const sub = (0, redis_1.createClient)(options);
exports.sub = sub;
Promise.all([pub.connect(), sub.connect()])
    .then(() => {
    console.log("Redis Publisher and Subscriber connected");
})
    .catch((err) => {
    console.error("Redis connection error:", err);
});
const subscribeToClient = async (io) => {
    sub.subscribe("SETUP", async (message) => {
        const data = JSON.parse(message);
        console.log("data===>", data);
        const { userId, socketId, conversationId } = data;
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            socket.join(userId);
            if (conversationId) {
                socket.join(conversationId);
            }
        }
        console.log("userId", userId);
        try {
            await user_1.userModel.findByIdAndUpdate({ _id: userId }, { isOnline: true, socketId }, { new: true });
            const dataResponse = {
                type: "USER_ONLINE",
                response: {
                    userId,
                    isOnline: true,
                },
            };
            io.emit("CONVERSATION_LISTENING", dataResponse);
        }
        catch (error) {
            console.log("error setup ", error);
        }
    });
    sub.subscribe("SEND_MESSAGE", async (message) => {
        try {
            const newMessage = JSON.parse(message);
            const { conversation, messageData } = newMessage;
            if (!conversation?.participants || conversation.participants.length < 1) {
                return console.log("ConversationData or participants not defined");
            }
            const dataResponse = {
                type: "NEW_MESSAGE",
                response: {
                    ...messageData,
                },
            };
            const dataResponseOrder = {
                type: "NEW_MESSAGE_PAGE",
                response: {
                    ...messageData,
                },
            };
            console.log("success", messageData.content);
            const delay = ["FILE", "VIDEO", "VOICE"].includes(messageData.messageType || "") ? 4000 : 0;
            await Promise.all(conversation.participants.map(async (participant) => {
                setTimeout(() => {
                    io.to(participant.user.toString()).emit("CONVERSATION_LISTENING", dataResponse);
                }, delay);
            }));
            io.to(conversation._id.toString()).emit("CONVERSATION_LISTENING", dataResponseOrder);
        }
        catch (error) {
            if (error instanceof Error) {
                console.error(`Error processing SEND_MESSAGE: ${error.message}`);
            }
            else {
                console.error("An unknown error occurred while processing SEND_MESSAGE");
            }
        }
    });
    sub.subscribe("READ_MESSAGE", async (message) => {
        try {
            const data = JSON.parse(message);
            const { userIds, conversationId } = data;
            const dataResponse = {
                type: "READ_MESSAGE",
                response: conversationId,
            };
            await Promise.all(userIds.map((userId) => {
                io.to(userId.toString()).emit("CONVERSATION_LISTENING", dataResponse);
            }));
        }
        catch (error) {
            console.log("error read message", error);
        }
    });
    sub.subscribe("USER_OFFLINE", async (message) => {
        try {
            const { socketId } = JSON.parse(message);
            const user = await user_1.userModel.findOneAndUpdate({ socketId }, { isOnline: false, socketId: null }, { new: true });
            if (!user) {
                throw new Error(`User not found with socketId: ${socketId}`);
            }
            const dataResponse = {
                type: "USER_ONLINE",
                response: {
                    userId: user._id,
                    isOnline: false,
                },
            };
            io.emit("CONVERSATION_LISTENING", dataResponse);
        }
        catch (error) {
            console.error(`Error in USER_OFFLINE handler:`, error instanceof Error ? error.message : "Unknown error");
        }
    });
};
exports.subscribeToClient = subscribeToClient;
//# sourceMappingURL=redis.js.map