import { Server } from "socket.io";
import { RedisClientType } from "redis";
declare const redisConfig: {
    socket: {
        host: string;
        port: number;
    };
    password: string | undefined;
    family: number;
    database: number;
};
declare const sub: RedisClientType;
declare const subscribeToClient: (io: Server) => Promise<void>;
declare const safePub: {
    publish: (channel: string, message: string) => Promise<void>;
    isConnected: () => boolean;
};
export { safePub as pub, sub, subscribeToClient, redisConfig };
//# sourceMappingURL=redis.d.ts.map