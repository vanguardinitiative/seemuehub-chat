import { z } from "zod";
declare const envSchema: z.ZodObject<{
    PORT: z.ZodDefault<z.ZodString>;
    MONGODB_URI: z.ZodString;
    REDIS_HOST: z.ZodString;
    REDIS_PORT: z.ZodString;
    REDIS_PASSWORD: z.ZodString;
    CHAT_SERVICE_URL: z.ZodDefault<z.ZodString>;
    CORS_ORIGIN: z.ZodDefault<z.ZodString>;
    SOCKET_CORS_ORIGIN: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export declare const env: {
    PORT: string;
    MONGODB_URI: string;
    REDIS_HOST: string;
    REDIS_PORT: string;
    REDIS_PASSWORD: string;
    CHAT_SERVICE_URL: string;
    CORS_ORIGIN: string;
    SOCKET_CORS_ORIGIN: string;
};
export type Env = z.infer<typeof envSchema>;
export {};
//# sourceMappingURL=env.d.ts.map