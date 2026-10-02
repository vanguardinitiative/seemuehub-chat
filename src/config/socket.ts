import { Server as SocketIOServer } from "socket.io";
import { pub, subscribeToClient } from "./redis";
import { env } from "./env";
import { sendGroupMessage, sendPrivateMessage } from "@/controllers/message";
import { conversationPartners, isParticipant, membersOf } from "@/utils/conversation-access";
import { findReactionTarget, writeReaction } from "@/services/reactions";
import { pushReaction } from "@/services/chat-push";
import { writeDelivered } from "@/services/delivered";
import { registerSocketHandlers } from "@/socket/handlers";

export type { SetupMessage as DataType } from "@/socket/handlers";

export interface MessageDataType {
  userId: string;
  payload: any;
}

export const setupSocketService = (server: any) => {
  const io = new SocketIOServer(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // Register a global installer to be invoked when Redis is ready
  (global as any).__installSubscriptions = () => subscribeToClient(io);

  // Try to subscribe immediately (in case Redis is already connected)
  subscribeToClient(io);

  console.log(`Socket auth mode: ${env.SOCKET_AUTH_MODE}`);

  // Handshake auth, SETUP, NEW_MESSAGE, NEW_GROUP_MESSAGE, REACT_MESSAGE,
  // TYPING, DELIVERED and disconnect: see src/socket/handlers.ts.
  registerSocketHandlers(io, {
    mode: env.SOCKET_AUTH_MODE,
    publish: (channel, message) => pub.publish(channel, message),
    isParticipant,
    conversationPartners,
    membersOf,
    sendPrivateMessage,
    sendGroupMessage,
    findReactionTarget,
    writeReaction,
    pushReaction,
    writeDelivered,
    stickerUrlPrefix: env.STICKER_URL_PREFIX,
  });

  return io;
};
