"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redisConfig = exports.subscribeToClient = exports.sub = exports.pub = void 0;
const redis_1 = require("redis");
const user_1 = require("../models/user");
const env_1 = require("./env");
const redisConfig = {
    socket: {
        host: env_1.env.REDIS_HOST,
        port: env_1.env.REDIS_PORT ? parseInt(env_1.env.REDIS_PORT, 10) : 6379,
    },
    password: env_1.env.REDIS_PASSWORD || undefined,
    family: 4,
    database: 0,
};
exports.redisConfig = redisConfig;
console.log("Redis configuration:", redisConfig);
const pub = (0, redis_1.createClient)(redisConfig);
const sub = (0, redis_1.createClient)(redisConfig);
exports.sub = sub;
let isRedisConnected = false;
pub.on("error", (err) => {
    console.error("Redis Publisher error:", err);
    isRedisConnected = false;
});
sub.on("error", (err) => {
    console.error("Redis Subscriber error:", err);
    isRedisConnected = false;
});
pub.on("connect", () => {
    console.log("Redis Publisher connected");
    isRedisConnected = true;
});
sub.on("connect", () => {
    console.log("Redis Subscriber connected");
    isRedisConnected = true;
});
pub.on("ready", () => {
    console.log("Redis Publisher ready");
});
sub.on("ready", () => {
    console.log("Redis Subscriber ready");
});
const connectRedis = async (retries = 3) => {
    try {
        await Promise.all([pub.connect(), sub.connect()]);
        console.log("Redis Publisher and Subscriber connected");
        isRedisConnected = true;
    }
    catch (err) {
        console.error("Redis connection error:", err);
        isRedisConnected = false;
        if (retries > 0) {
            console.log(`Retrying Redis connection... ${retries} attempts left`);
            setTimeout(() => connectRedis(retries - 1), 5000);
        }
        else {
            console.warn("Redis connection failed after all retries. Server will continue without Redis.");
        }
    }
};
const safePublish = async (channel, message) => {
    try {
        if (isRedisConnected && pub.isOpen) {
            await pub.publish(channel, message);
        }
        else {
            console.warn(`Redis not connected. Skipping publish to ${channel}`);
        }
    }
    catch (error) {
        console.error(`Error publishing to ${channel}:`, error);
    }
};
const subscribeToClient = async (io) => {
    if (!isRedisConnected || !sub.isOpen) {
        console.warn("Redis not connected. Skipping subscription setup.");
        return;
    }
    try {
        sub.subscribe("SETUP", async (message) => {
            try {
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
        console.log("Redis subscriptions set up successfully");
    }
    catch (error) {
        console.error("Error setting up Redis subscriptions:", error);
    }
};
exports.subscribeToClient = subscribeToClient;
connectRedis();
const safePub = {
    publish: safePublish,
    isConnected: () => isRedisConnected,
};
exports.pub = safePub;
//# sourceMappingURL=redis.js.map