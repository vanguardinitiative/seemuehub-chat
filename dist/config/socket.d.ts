export interface DataType {
    userId: string;
    socketId: string;
    conversationId?: string;
}
export interface MessageDataType {
    userId: string;
    payload: any;
}
export declare const setupSocketService: (server: any) => void;
//# sourceMappingURL=socket.d.ts.map