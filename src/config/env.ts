import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().default("3001"),
  MONGODB_URI: z.string().min(1, "MongoDB URI is required"),

  // Redis Configuration
  REDIS_HOST: z.string(),
  REDIS_PORT: z.string(),
  REDIS_PASSWORD: z.string(),

  // Chat Service Configuration
  CHAT_SERVICE_URL: z.string().default("http://localhost:3001"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),

  // Socket Configuration
  SOCKET_CORS_ORIGIN: z.string().default("http://localhost:5173"),

  // Shared with seemuehub-backend. When set, /core-socket/* only accepts
  // requests carrying it as X-Internal-Key.
  CHAT_INTERNAL_KEY: z.string().optional(),

  // What a socket that connects without `auth: { token }` may do (see
  // src/socket/auth.ts and the README). "permissive" keeps the old behaviour
  // and logs `legacy_socket`; "enforce" refuses SETUP and message sends.
  // A value that is neither stops the service at boot rather than guessing.
  SOCKET_AUTH_MODE: z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : undefined),
    z.enum(["permissive", "enforce"]).default("permissive")
  ),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
