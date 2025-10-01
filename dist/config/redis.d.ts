import { Server } from "socket.io";
import { RedisClientType } from "redis";
declare const pub: RedisClientType;
declare const sub: RedisClientType;
declare const subscribeToClient: (io: Server) => Promise<void>;
export { pub, sub, subscribeToClient };
//# sourceMappingURL=redis.d.ts.map