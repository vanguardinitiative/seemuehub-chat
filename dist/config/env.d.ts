import { z } from "zod";
declare const envSchema: z.ZodObject<{
    PORT: z.ZodDefault<z.ZodString>;
    MONGODB_URI: z.ZodString;
    NODE_ENV: z.ZodDefault<z.ZodEnum<{
        development: "development";
        production: "production";
        test: "test";
    }>>;
    REDIS_HOST: z.ZodDefault<z.ZodString>;
    REDIS_PORT: z.ZodDefault<z.ZodString>;
    REDIS_PASSWORD: z.ZodOptional<z.ZodString>;
    CHAT_SERVICE_URL: z.ZodDefault<z.ZodString>;
    CORS_ORIGIN: z.ZodDefault<z.ZodString>;
    SOCKET_CORS_ORIGIN: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export declare const env: {
    PORT: string;
    MONGODB_URI: string;
    NODE_ENV: "development" | "production" | "test";
    REDIS_HOST: string;
    REDIS_PORT: string;
    CHAT_SERVICE_URL: string;
    CORS_ORIGIN: string;
    SOCKET_CORS_ORIGIN: string;
    REDIS_PASSWORD?: string | undefined;
};
export type Env = z.infer<typeof envSchema>;
export {};
//# sourceMappingURL=env.d.ts.map