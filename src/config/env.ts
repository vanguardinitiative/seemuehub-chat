import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().default("3001"),
  MONGODB_URI: z.string().min(1, "MongoDB URI is required"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Redis Configuration
  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.string().default("6379"),
  REDIS_PASSWORD: z.string().optional(),

  // Chat Service Configuration
  CHAT_SERVICE_URL: z.string().default("http://localhost:3001"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),

  // Socket Configuration
  SOCKET_CORS_ORIGIN: z.string().default("http://localhost:5173"),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
