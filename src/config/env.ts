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

  // Shared with seemuehub-backend, both ways. When set, the backend-only
  // routes (/orders, /core-socket/*) require it as X-Internal-Key, and it is
  // sent as X-Internal-Key on the push requests to BACKEND_URL.
  CHAT_INTERNAL_KEY: z.string().optional(),

  // seemuehub-backend's origin, e.g. https://api.seemuehub.com (no /api/v1).
  // With CHAT_INTERNAL_KEY, a stored private message is pushed to its other
  // participants through POST {BACKEND_URL}/api/v1/internal/push/chat
  // (src/services/chat-push.ts). Unset: no pushes.
  BACKEND_URL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined),
    z.string().url().optional()
  ),

  // What a socket that connects without `auth: { token }` may do (see
  // src/socket/auth.ts and the README). "permissive" keeps the old behaviour
  // and logs `legacy_socket`; "enforce" refuses SETUP and message sends.
  // A value that is neither stops the service at boot rather than guessing.
  SOCKET_AUTH_MODE: z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : undefined),
    z.enum(["permissive", "enforce"]).default("permissive")
  ),

  // Where sticker images live. A STICKER message's one attachment must point
  // under it (src/utils/sticker.ts); the backend only accepts sticker URLs
  // under the same bucket's public images/ prefix. The default is production's
  // bucket, so it only needs setting if the bucket moves. It must end in "/":
  // without it, "https://bucket.example.com" would also let through
  // "https://bucket.example.com.evil.net/...". A bad value stops the service
  // at boot rather than refusing every sticker.
  STICKER_URL_PREFIX: z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined),
    z
      .string()
      .url()
      .refine((value) => value.startsWith("https://") && value.endsWith("/"), "STICKER_URL_PREFIX must be an https URL ending in /")
      .default("https://seemuehub-storage.s3.ap-southeast-1.amazonaws.com/images/")
  ),

  // Company ↔ candidate chat (worktrees/ORG-CHAT-CONTRACT.md, src/services/org-chat.ts).
  // Off unless exactly "true": opening a company conversation answers 403
  // ORG_CHAT_DISABLED, the new routes too, and the routes that existed
  // before behave as they did. seemuehub-backend has a switch of the same
  // name; both are turned on together.
  ORG_CHAT_ENABLED: z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : undefined),
    z.enum(["true", "false"]).default("false")
  ),

  // Staff RBAC (worktrees/ADMIN-RBAC-CONTRACT.md §8, src/middleware/admin.ts).
  // "true": the admin oversight endpoints take only an admin session - a
  // password + TOTP token (`aud: "admin"`) of an ACTIVE, enrolled staff member
  // whose sessionVersion still matches. "false" (the default) also lets a
  // plain token of a not-yet-enrolled staff member through, with that
  // member's own roles. Either way the roles must grant chats.read. The
  // backend has a switch of the same name; both are turned on together.
  ADMIN_SESSION_ENFORCED: z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : undefined),
    z.enum(["true", "false"]).default("false")
  ),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
