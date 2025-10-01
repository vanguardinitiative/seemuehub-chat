import { Server } from "socket.io";
import { RedisClientType, createClient } from "redis";
import { DataType } from "./socket";
import { IConversation } from "@/models/conversation";
import { IMessage } from "@/models/message";
import { userModel } from "@/models/user";
import { env } from "./env";

// Redis configuration matching seemuehub-backend style
const redisConfig = {
  socket: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT ? parseInt(env.REDIS_PORT, 10) : 6379,
  },
  password: env.REDIS_PASSWORD || undefined,
  family: 4,
  database: 0,
};

console.log("Redis configuration:", redisConfig);

// Create Redis clients
const pub: RedisClientType = createClient(redisConfig);
const sub: RedisClientType = createClient(redisConfig);

// Track Redis connection status
let isRedisConnected = false;

// Error handlers for Redis clients
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

// Graceful connection with retry logic
const connectRedis = async (retries = 3): Promise<void> => {
  try {
    await Promise.all([pub.connect(), sub.connect()]);
    console.log("Redis Publisher and Subscriber connected");
    isRedisConnected = true;
  } catch (err) {
    console.error("Redis connection error:", err);
    isRedisConnected = false;

    if (retries > 0) {
      console.log(`Retrying Redis connection... ${retries} attempts left`);
      setTimeout(() => connectRedis(retries - 1), 5000); // Retry after 5 seconds
    } else {
      console.warn("Redis connection failed after all retries. Server will continue without Redis.");
    }
  }
};

// Safe publish function that won't crash the server
const safePublish = async (channel: string, message: string): Promise<void> => {
  try {
    if (isRedisConnected && pub.isOpen) {
      await pub.publish(channel, message);
    } else {
      console.warn(`Redis not connected. Skipping publish to ${channel}`);
    }
  } catch (error) {
    console.error(`Error publishing to ${channel}:`, error);
  }
};

const subscribeToClient = async (io: Server): Promise<void> => {
  // Only subscribe if Redis is connected
  if (!isRedisConnected || !sub.isOpen) {
    console.warn("Redis not connected. Skipping subscription setup.");
    return;
  }

  try {
    sub.subscribe("SETUP", async (message: string) => {
      try {
        const data: DataType = JSON.parse(message);
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

        await userModel.findByIdAndUpdate({ _id: userId }, { isOnline: true, socketId }, { new: true });
        const dataResponse = {
          type: "USER_ONLINE",
          response: {
            userId,
            isOnline: true,
          },
        };
        io.emit("CONVERSATION_LISTENING", dataResponse);
      } catch (error) {
        console.log("error setup ", error);
      }
    });
    sub.subscribe("SEND_MESSAGE", async (message: string) => {
      try {
        interface SendMessageData {
          conversation: IConversation;
          messageData: IMessage;
        }

        const newMessage: SendMessageData = JSON.parse(message);
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
        const delay: number = ["FILE", "VIDEO", "VOICE"].includes(messageData.messageType || "") ? 4000 : 0;

        await Promise.all(
          conversation.participants.map(async (participant) => {
            setTimeout(() => {
              io.to(participant.user.toString()).emit("CONVERSATION_LISTENING", dataResponse);
            }, delay);
          })
        );
        // If the conversation is of type ORDER, emit to the conversation room as well
        io.to(conversation._id.toString()).emit("CONVERSATION_LISTENING", dataResponseOrder);
      } catch (error) {
        if (error instanceof Error) {
          console.error(`Error processing SEND_MESSAGE: ${error.message}`);
        } else {
          console.error("An unknown error occurred while processing SEND_MESSAGE");
        }
      }
    });

    sub.subscribe("READ_MESSAGE", async (message: string) => {
      interface readMessageData {
        userIds: string[];
        conversationId?: string;
      }
      try {
        const data: readMessageData = JSON.parse(message);
        const { userIds, conversationId } = data;
        const dataResponse = {
          type: "READ_MESSAGE",
          response: conversationId,
        };
        // Emit to all participants concurrently
        await Promise.all(
          userIds.map((userId) => {
            io.to(userId.toString()).emit("CONVERSATION_LISTENING", dataResponse);
          })
        );
      } catch (error) {
        console.log("error read message", error);
      }
    });

    interface UserOfflineMessage {
      socketId: string;
    }

    sub.subscribe("USER_OFFLINE", async (message: string) => {
      try {
        const { socketId } = JSON.parse(message) as UserOfflineMessage;

        const user = await userModel.findOneAndUpdate({ socketId }, { isOnline: false, socketId: null }, { new: true });

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
      } catch (error) {
        console.error(`Error in USER_OFFLINE handler:`, error instanceof Error ? error.message : "Unknown error");
      }
    });

    console.log("Redis subscriptions set up successfully");
  } catch (error) {
    console.error("Error setting up Redis subscriptions:", error);
  }
};

// Start Redis connection
connectRedis();

// Create a wrapper for pub that uses safePublish
const safePub = {
  publish: safePublish,
  isConnected: () => isRedisConnected,
};

export { safePub as pub, sub, subscribeToClient, redisConfig };
