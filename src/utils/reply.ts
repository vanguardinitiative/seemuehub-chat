/**
 * Replies (worktrees/CHAT-CONTRACT.md §2), as pure functions over the stored
 * target message the way Mongo hands it back (lean or hydrated).
 *
 * A client asks for a reply with `replyTo: "<messageId>"` on NEW_MESSAGE /
 * NEW_GROUP_MESSAGE. Once the send has resolved its conversation, the
 * controller looks the target up (controllers/message/reply.ts) and these
 * decide: a target in the same conversation that is neither deleted nor an
 * order message makes the message a reply, with a preview built here from the
 * stored target. Anything else drops the reply and the message is delivered
 * as a normal one.
 */

/** A TEXT target's text in the preview is at most this long (CHAT-CONTRACT.md §2.1). */
export const REPLY_TEXT_MAX = 160;
/** A FILE target's name in the preview is clipped the same way. */
export const REPLY_FILE_NAME_MAX = 160;

/** The fields of a stored message a reply reads. */
export interface ReplyTarget {
  _id?: unknown;
  conversation?: unknown;
  sender?: unknown;
  messageType?: unknown;
  content?: unknown;
  attachments?: { fileName?: unknown; fileUrl?: unknown; originalName?: unknown }[] | null;
  isDeleted?: unknown;
  isOrderMessage?: unknown;
}

export interface ReplyPreview {
  messageId: unknown;
  senderId: string;
  messageType: string;
  text: string;
  fileName?: string;
  thumbUrl?: string;
}

/** Why a reply was dropped; logged as `reply_dropped`, never sent to the client. */
export type ReplyDropReason = "INVALID_ID" | "NOT_FOUND" | "OTHER_CONVERSATION" | "DELETED" | "ORDER_MESSAGE";

export const isObjectIdString = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value);

/** An id as a string, from a string, an ObjectId, or anything with an `_id`. */
const idString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && typeof (value as { toHexString?: unknown }).toHexString === "function") {
    return String((value as { toHexString: () => string }).toHexString());
  }
  if (typeof value === "object" && "_id" in (value as object)) return idString((value as { _id: unknown })._id);
  const text = String(value);
  return text.length > 0 ? text : null;
};

/** Whether the payload asked for a reply at all: `replyTo` present and not empty. */
export const asksForReply = (replyTo: unknown): boolean =>
  replyTo !== undefined && replyTo !== null && replyTo !== "";

/**
 * Why `target` cannot be replied to from `conversationId`, or null when it
 * can. `target` is the stored message `replyTo` names (null when there is
 * none).
 */
export const replyDropReason = (
  replyTo: unknown,
  target: ReplyTarget | null | undefined,
  conversationId: unknown
): ReplyDropReason | null => {
  if (!isObjectIdString(replyTo)) return "INVALID_ID";
  if (!target) return "NOT_FOUND";
  const targetConversation = idString(target.conversation);
  if (!targetConversation || targetConversation !== idString(conversationId)) return "OTHER_CONVERSATION";
  if (target.isDeleted === true) return "DELETED";
  if (target.isOrderMessage === true) return "ORDER_MESSAGE";
  return null;
};

const segmenter =
  typeof Intl !== "undefined" && typeof (Intl as { Segmenter?: unknown }).Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * `text` cut to at most `max` UTF-16 units (so `.length <= max` on every
 * client) without splitting a character: whole grapheme clusters, so neither
 * an emoji nor a Lao vowel sign is cut from its consonant.
 */
export const clipText = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const parts = segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);
  let clipped = "";
  for (const part of parts) {
    if (clipped.length + part.length > max) break;
    clipped += part;
  }
  return clipped;
};

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const isHttpUrl = (value: unknown): value is string => typeof value === "string" && /^https?:\/\//i.test(value);

/**
 * The preview stored on a reply, from its stored target (CHAT-CONTRACT.md
 * §2.1):
 * - TEXT: `text` is the content clipped to 160; every other type has `text: ""`.
 * - FILE: `fileName` is the first attachment's originalName, or its fileName.
 * - IMAGE: `thumbUrl` is the first attachment's fileUrl.
 * - STICKER: `thumbUrl` is the sticker's url. The contract calls that the
 *   content, but a stored sticker's content is the literal "STICKER" (the
 *   service forces it, STICKER-CONTRACT.md §4) and its url is the attachment's
 *   fileUrl; a content that is itself a url is the fallback.
 * - VOICE, VIDEO and the rest: just the type.
 */
export const buildReplyPreview = (target: ReplyTarget): ReplyPreview => {
  const messageType = nonEmpty(target.messageType) ?? "TEXT";
  const first = Array.isArray(target.attachments) ? target.attachments[0] : undefined;
  const preview: ReplyPreview = {
    messageId: target._id,
    senderId: idString(target.sender) ?? "",
    messageType,
    text: messageType === "TEXT" && typeof target.content === "string" ? clipText(target.content, REPLY_TEXT_MAX) : "",
  };

  if (messageType === "FILE") {
    const fileName = nonEmpty(first?.originalName) ?? nonEmpty(first?.fileName);
    if (fileName) preview.fileName = clipText(fileName, REPLY_FILE_NAME_MAX);
  } else if (messageType === "IMAGE") {
    const thumbUrl = nonEmpty(first?.fileUrl);
    if (thumbUrl) preview.thumbUrl = thumbUrl;
  } else if (messageType === "STICKER") {
    const thumbUrl = nonEmpty(first?.fileUrl) ?? (isHttpUrl(target.content) ? target.content : undefined);
    if (thumbUrl) preview.thumbUrl = thumbUrl;
  }
  return preview;
};
