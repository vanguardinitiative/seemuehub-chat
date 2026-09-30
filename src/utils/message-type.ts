import { MessageType } from "@/models/message";

/**
 * The message types a client may send. Everything else in MessageType is
 * written by the service itself: SYSTEM, and the ORDER_* types that render as
 * order events in the order conversation. A client that could send those could
 * post a fake "payment received" or "order completed" into any conversation it
 * is in.
 *
 * An allowlist, so a type added to the model later is server-only until it is
 * added here.
 */
export const CLIENT_MESSAGE_TYPES: ReadonlySet<string> = new Set<string>([
  MessageType.TEXT,
  MessageType.IMAGE,
  MessageType.VIDEO,
  MessageType.VOICE,
  MessageType.FILE,
  MessageType.REACTION,
  MessageType.STICKER,
  MessageType.LOCATION,
  MessageType.VOICE_CALL,
  MessageType.VIDEO_CALL,
]);

export const isClientMessageType = (value: unknown): value is string =>
  typeof value === "string" && CLIENT_MESSAGE_TYPES.has(value);
