import { Server } from "socket.io";
import { RedisClientType, createClient } from "redis";
import { DataType } from "./socket";
import { IConversation } from "@/models/conversation";
import { IMessage } from "@/models/message";
import { userModel } from "@/models/user";
import { env } from "./env";
import { describeRedisConfig } from "./redis-log";
import {
  deliverPayment,
  deliverReaction,
  deliverReadMessage,
  emitPresence,
  joinSetupRooms,
  routePayment,
  type ReactionNotice,
  type ReadMessageNotice,
} from "@/socket/rooms";

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

// Host and port only: never the password (config/redis-log.ts).
console.log("Redis configuration:", describeRedisConfig(redisConfig));

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
  // Defer: after subscriber is ready, (re-)install subscriptions
  if (typeof (global as any).__installSubscriptions === "function") {
    (global as any).__installSubscriptions();
  }
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
        // Published by the SETUP handler (src/socket/handlers.ts), which has
        // already put the verified user in `userId` and checked membership of
        // `conversationId`.
        const data: DataType = JSON.parse(message);
        const { userId, socketId, partners } = data;
        if (!userId) return;
        if (joinSetupRooms(io, data) === "refused") return;

        await userModel.findByIdAndUpdate({ _id: userId }, { isOnline: true, socketId }, { new: true });
        emitPresence(io, partners, { userId, isOnline: true });
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
      try {
        // Published by PUT /message-status/read to the reader (and the latest
        // sender once it is read by all): see deliverReadMessage.
        deliverReadMessage(io, JSON.parse(message) as ReadMessageNotice);
      } catch (error) {
        console.error("Error processing READ_MESSAGE:", error instanceof Error ? error.message : error);
      }
    });

    sub.subscribe("REACTION", async (message: string) => {
      try {
        // Published by REACT_MESSAGE (src/socket/handlers.ts) after its write:
        // every participant, the reactor included. See deliverReaction.
        deliverReaction(io, JSON.parse(message) as ReactionNotice);
      } catch (error) {
        console.error("Error processing REACTION:", error instanceof Error ? error.message : error);
      }
    });

    interface UserOfflineMessage {
      socketId: string;
      userId?: string;
      partners?: string[];
    }

    sub.subscribe("USER_OFFLINE", async (message: string) => {
      try {
        const { socketId, partners } = JSON.parse(message) as UserOfflineMessage;

        // No match when another socket of the same user has set up since:
        // that one is the user's socketId now, and the user is still online.
        const user = await userModel.findOneAndUpdate({ socketId }, { isOnline: false, socketId: null }, { new: true });
        if (!user) return;

        emitPresence(io, partners, { userId: user._id, isOnline: false });
      } catch (error) {
        console.error(`Error in USER_OFFLINE handler:`, error instanceof Error ? error.message : "Unknown error");
      }
    });

    sub.subscribe("PAYMENT", async (message: string) => {
      try {
        const data: any = JSON.parse(message);

        // A payment goes to its payer's room (sockets join their userId on
        // SETUP). Anonymous donations are the one broadcast left, and only
        // in permissive mode: see routePayment in src/socket/rooms.ts.
        const deliveries = routePayment(data, env.SOCKET_AUTH_MODE);
        if (deliveries.length === 0) {
          console.warn("PAYMENT without a userId was not delivered", { id: data?._id, type: data?.type });
          return;
        }
        deliverPayment(io, deliveries);
      } catch (error) {
        console.log("error core socket", error);
      }
    });
    sub.subscribe("ORDER", async (message: string) => {
      try {
        const data: any = JSON.parse(message);

        // Send ORDER notification to participants
        const dataResponse = {
          type: "ORDER",
          response: data,
        };
        const participants = data.participants;
        await Promise.all(
          participants.map((participant: { user: any }) => {
            io.to(participant.user.toString()).emit("CONVERSATION_LISTENING", dataResponse);
          })
        );
      } catch (error) {
        console.error("error core socket", error instanceof Error ? error.message : "Unknown error", error);
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
