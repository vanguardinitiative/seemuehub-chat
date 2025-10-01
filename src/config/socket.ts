import { Server as SocketIOServer } from "socket.io";
import { pub, subscribeToClient } from "./redis";
import { sendGroupMessage, sendPrivateMessage } from "@/controllers/message";
export interface DataType {
  userId: string;
  socketId: string;
  conversationId?: string;
}

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
  subscribeToClient(io);

  io.on("connection", (socket) => {
    console.log("Frontend client connected: ", socket.id);

    socket.on("SETUP", (data: DataType) => {
      console.log("SETUP", data);
      pub.publish("SETUP", JSON.stringify({ ...data, socketId: socket.id }));
    });

    socket.on("NEW_MESSAGE", (data: any) => {
      try {
        // const { payload } = data;
        console.log("NEW_MESSAGE", data);
        sendPrivateMessage(socket, io, data);
      } catch (error) {
        console.error("Error handling NEW_MESSAGE:", error);
      }
    });
    socket.on("NEW_GROUP_MESSAGE", (data: any) => {
      try {
        // const { payload } = data;
        console.log("NEW_GROUP_MESSAGE", data);
        sendGroupMessage(socket, io, data);
      } catch (error) {
        console.error("Error handling NEW_MESSAGE:", error);
      }
    });

    // Global disconnect handler
    socket.on("disconnect", () => {
      pub.publish("USER_OFFLINE", JSON.stringify({ socketId: socket.id }));
      console.log("Frontend client disconnected: ", socket.id);
    });
  });
};
