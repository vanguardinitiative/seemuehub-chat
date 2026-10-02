import axios from "axios";
import { Types } from "mongoose";
import { env } from "@/config/env";
import { isClientMessageType } from "@/utils/message-type";
import { isReaction } from "@/utils/reactions";

/**
 * New-message and reaction pushes, through seemuehub-backend.
 *
 * The backend owns the users' device tokens, so when a message is stored this
 * service asks it to push: `POST {BACKEND_URL}/api/v1/internal/push/chat`
 * with the shared CHAT_INTERNAL_KEY as X-Internal-Key. It answers
 * `{ success, data: { sent } }`; the push is best effort on both sides.
 *
 * Fire and forget: `pushChatMessage` never throws and nobody awaits it, so a
 * slow or failing backend can neither delay nor fail the message. Without
 * BACKEND_URL or CHAT_INTERNAL_KEY it does nothing.
 */

export const CHAT_PUSH_PATH = "/api/v1/internal/push/chat";
export const CHAT_PUSH_TIMEOUT_MS = 3_000;
/** The backend's limits (chat-push.schema.ts there). */
export const CHAT_PUSH_LIMITS = { recipients: 50, snippet: 140, messageId: 64, imageUrl: 2048 } as const;

export interface ChatPushBody {
  conversationId: string;
  senderId: string;
  recipientIds: string[];
  messageType: string;
  snippet?: string;
  /**
   * For rich notifications (PUSH-CONTRACT.md §10), all optional: the stored
   * message's id, the conversation's type (an ANONYMOUS one names nobody),
   * and an IMAGE's photo or a STICKER's picture for the notification to show.
   */
  messageId?: string;
  conversationType?: string;
  imageUrl?: string;
}

/** The fields of a stored conversation and message this reads. */
export interface PushConversation {
  _id: unknown;
  conversationType?: unknown;
  participants?: { user?: unknown; isMuted?: boolean }[];
}
export interface PushMessage {
  _id?: unknown;
  sender?: unknown;
  messageType?: unknown;
  content?: unknown;
  attachments?: { fileUrl?: unknown }[];
  isOrderMessage?: boolean;
}

const idOf = (value: unknown): string | null => {
  const id = value && typeof value === "object" && "_id" in value ? (value as { _id: unknown })._id : value;
  if (id === null || id === undefined) return null;
  const text = String(id);
  return Types.ObjectId.isValid(text) && /^[0-9a-fA-F]{24}$/.test(text) ? text : null;
};

/** A message id as text: an ObjectId or a client's custom id, at most 64 characters. */
const messageIdOf = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text && text.length <= CHAT_PUSH_LIMITS.messageId ? text : undefined;
};

const httpUrl = (value: unknown): string | undefined =>
  typeof value === "string" && /^https?:\/\//i.test(value.trim()) && value.trim().length <= CHAT_PUSH_LIMITS.imageUrl
    ? value.trim()
    : undefined;

/**
 * The picture a notification may show for this message: an IMAGE's first
 * attachment, a STICKER's attachment (or, for older stickers, its content when
 * that is a URL). Nothing for any other type. The backend still decides
 * whether it is one of our own images. Pure.
 */
export const imageUrlOf = (message: PushMessage): string | undefined => {
  const first = Array.isArray(message.attachments) ? message.attachments[0] : undefined;
  if (message.messageType === "IMAGE") return httpUrl(first?.fileUrl);
  if (message.messageType === "STICKER") return httpUrl(first?.fileUrl) ?? httpUrl(message.content);
  return undefined;
};

/** A TEXT message's text for the lock screen: whitespace folded, at most 140 characters (not UTF-16 units). */
export const snippetOf = (content: unknown): string | undefined => {
  if (typeof content !== "string") return undefined;
  const folded = content.replace(/\s+/g, " ").trim();
  if (!folded) return undefined;
  const chars = Array.from(folded);
  return chars.length <= CHAT_PUSH_LIMITS.snippet ? folded : `${chars.slice(0, CHAT_PUSH_LIMITS.snippet - 1).join("")}…`;
};

/**
 * The request bodies for one stored message: one per 50 recipients, none when
 * there is nobody to tell. Pure.
 *
 * Recipients are the conversation's participants except the sender and anyone
 * who muted it. Order and system messages are never pushed from here: the
 * backend already notifies its own order events.
 */
export const chatPushBodies = (conversation: PushConversation | null | undefined, message: PushMessage | null | undefined): ChatPushBody[] => {
  if (!conversation || !message) return [];
  if (message.isOrderMessage) return [];
  if (!isClientMessageType(message.messageType)) return [];

  const conversationId = idOf(conversation._id);
  const senderId = idOf(message.sender);
  if (!conversationId || !senderId) return [];

  const recipients = [
    ...new Set(
      (conversation.participants ?? [])
        .filter((participant) => participant && !participant.isMuted)
        .map((participant) => idOf(participant.user))
        .filter((id): id is string => id !== null && id !== senderId)
    ),
  ];
  if (recipients.length === 0) return [];

  const snippet = message.messageType === "TEXT" ? snippetOf(message.content) : undefined;
  const messageId = messageIdOf(message._id);
  const conversationType = typeof conversation.conversationType === "string" ? conversation.conversationType : undefined;
  const imageUrl = imageUrlOf(message);
  const bodies: ChatPushBody[] = [];
  for (let i = 0; i < recipients.length; i += CHAT_PUSH_LIMITS.recipients) {
    bodies.push({
      conversationId,
      senderId,
      recipientIds: recipients.slice(i, i + CHAT_PUSH_LIMITS.recipients),
      messageType: message.messageType,
      ...(snippet ? { snippet } : {}),
      ...(messageId ? { messageId } : {}),
      ...(conversationType ? { conversationType } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    });
  }
  return bodies;
};

/** The `messageType` of a reaction push (CHAT-CONTRACT.md §3.5): the backend words it "reacted {emoji}". */
export const REACTION_PUSH_TYPE = "REACTION";

/** A reaction to tell a message's author about (REACT_MESSAGE, socket/handlers.ts). */
export interface ReactionPush {
  conversationId: string;
  /** The message's sender: the one pushed to. */
  authorId: unknown;
  reactorId: string;
  emoji: string;
  /** The conversation's participants, with whether each muted it (utils/conversation-access.ts membersOf). */
  members: { userId: string; isMuted: boolean }[];
}

/**
 * The request body for a reaction, or null when nobody is to be told. Pure.
 *
 * The author only, and only when they are someone else, still a participant,
 * and have not muted the conversation (the rule message pushes follow), and
 * the emoji is one of the six. `snippet` is the emoji. Whether this reaction
 * is new (added or changed, not removed or the same again) is the caller's
 * to decide.
 */
export const reactionPushBody = (push: ReactionPush | null | undefined): ChatPushBody | null => {
  if (!push) return null;
  const conversationId = idOf(push.conversationId);
  const authorId = idOf(push.authorId);
  const reactorId = idOf(push.reactorId);
  if (!conversationId || !authorId || !reactorId || authorId === reactorId) return null;
  if (!isReaction(push.emoji)) return null;
  const author = (push.members ?? []).find((member) => member?.userId === authorId);
  if (!author || author.isMuted) return null;
  return { conversationId, senderId: reactorId, recipientIds: [authorId], messageType: REACTION_PUSH_TYPE, snippet: push.emoji };
};

export interface ChatPushDeps {
  /** Read per call: the configuration as it is now. */
  config: () => { backendUrl?: string; internalKey?: string };
  post: (url: string, body: unknown, options: { timeout: number; headers: Record<string, string> }) => Promise<unknown>;
}

const defaultDeps: ChatPushDeps = {
  config: () => ({ backendUrl: env.BACKEND_URL, internalKey: env.CHAT_INTERNAL_KEY }),
  post: (url, body, options) => axios.post(url, body, options),
};

/**
 * Ask the backend to push `message` to the other participants. Resolves when
 * every request has settled; never rejects. Callers do not await it.
 */
export const pushChatMessage = async (
  conversation: PushConversation | null | undefined,
  message: PushMessage | null | undefined,
  deps: ChatPushDeps = defaultDeps
): Promise<void> => postChatPushes(() => chatPushBodies(conversation, message), deps);

/**
 * Ask the backend to tell a message's author that someone reacted to it
 * (CHAT-CONTRACT.md §3.5). Same terms as pushChatMessage: fire and forget,
 * never rejects, nothing without BACKEND_URL and CHAT_INTERNAL_KEY.
 */
export const pushReaction = async (push: ReactionPush, deps: ChatPushDeps = defaultDeps): Promise<void> =>
  postChatPushes(() => {
    const body = reactionPushBody(push);
    return body ? [body] : [];
  }, deps);

/** Posts the bodies `build` returns; swallows and logs every failure, its own included. */
const postChatPushes = async (build: () => ChatPushBody[], deps: ChatPushDeps): Promise<void> => {
  try {
    const { backendUrl, internalKey } = deps.config();
    if (!backendUrl || !internalKey) return;

    const bodies = build();
    if (bodies.length === 0) return;

    const url = `${backendUrl.replace(/\/+$/, "")}${CHAT_PUSH_PATH}`;
    await Promise.all(
      bodies.map(async (body) => {
        try {
          await deps.post(url, body, { timeout: CHAT_PUSH_TIMEOUT_MS, headers: { "X-Internal-Key": internalKey } });
        } catch (error) {
          // Ids and the status only: never the message text.
          const status = (error as { response?: { status?: number } })?.response?.status ?? null;
          const code = (error as { code?: string })?.code ?? null;
          console.warn(JSON.stringify({ msg: "chat_push_failed", conversationId: body.conversationId, status, code }));
        }
      })
    );
  } catch (error) {
    console.warn(JSON.stringify({ msg: "chat_push_failed", error: error instanceof Error ? error.message : String(error) }));
  }
};
