import { Socket, Server } from "socket.io";
import type { Request, Response } from "express";
interface MessageData {
    messageType: string;
    content: string;
    conversationId?: string;
    senderId: string;
    receiverId: string;
    _id?: string;
}
declare const sendPrivateMessage: (socket: Socket, io: Server, data: MessageData) => Promise<void>;
declare const sendGroupMessage: (socket: Socket, io: Server, data: MessageData) => Promise<void>;
declare const getAllMessage: (req: Request, res: Response) => Promise<void>;
declare const getAllMessageHistory: (req: Request, res: Response) => Promise<void>;
export { sendPrivateMessage, sendGroupMessage, getAllMessage, getAllMessageHistory };
//# sourceMappingURL=index.d.ts.map