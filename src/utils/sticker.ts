/**
 * STICKER messages (worktrees/STICKER-CONTRACT.md §4).
 *
 * A sticker is sent like any other message:
 *
 *   { messageType: "STICKER", content: "STICKER",
 *     attachments: [{ fileName: <sticker _id>, fileUrl: <sticker url> }] }
 *
 * Clients draw it as a bare 120×120 image with no bubble, so without a check a
 * STICKER could show any image from anywhere as if it were one of ours (or a
 * tracking pixel), with any text riding along in `content`. Every path that
 * accepts a client message runs this: the socket's NEW_MESSAGE /
 * NEW_GROUP_MESSAGE and both REST sends.
 *
 * The backend is not asked whether the sticker still exists. A deleted sticker
 * still cached in a client is harmless, and its image stays in the bucket:
 * deleting a sticker never deletes the object, so sent ones keep rendering.
 *
 * Pure, with the prefix passed in, so the socket layer and the tests need no
 * env.
 */

export const STICKER_CONTENT = "STICKER";

export interface StickerAttachment {
  fileName: string;
  fileUrl: string;
}

/** Why a STICKER was refused; logged, never sent to the client. */
export type StickerRefusal = "ATTACHMENT_COUNT" | "FILE_URL" | "FILE_NAME";

export type StickerCheck =
  | { ok: true; content: typeof STICKER_CONTENT; attachments: [StickerAttachment] }
  | { ok: false; reason: StickerRefusal };

/** The sticker's _id, which is what the contract puts in fileName. */
const STICKER_ID = /^[0-9a-fA-F]{24}$/;

/**
 * Under `prefix` both as written and as a browser will resolve it. The second
 * test is what catches ".../images/../private/x" (also spelled %2e%2e, or with
 * backslashes): the raw string starts with the prefix, the URL it loads does
 * not.
 */
const isUnder = (url: string, prefix: string): boolean => {
  if (!url.startsWith(prefix)) return false;
  try {
    return new URL(url).href.startsWith(new URL(prefix).href);
  } catch {
    return false;
  }
};

/**
 * Checks a STICKER message's attachments: exactly one, its fileUrl under
 * `prefix` (STICKER_URL_PREFIX), its fileName a 24-hex id. On a pass, returns
 * what to store: content forced to "STICKER", and the attachment cut down to
 * those two fields so nothing else a client sent (originalName, fileSize) is
 * stored with it.
 */
export const checkSticker = (attachments: unknown, prefix: string): StickerCheck => {
  if (!Array.isArray(attachments) || attachments.length !== 1) return { ok: false, reason: "ATTACHMENT_COUNT" };

  const attachment = attachments[0];
  const { fileName, fileUrl } = (attachment && typeof attachment === "object" ? attachment : {}) as Record<string, unknown>;
  if (typeof fileUrl !== "string" || !isUnder(fileUrl, prefix)) return { ok: false, reason: "FILE_URL" };
  if (typeof fileName !== "string" || !STICKER_ID.test(fileName)) return { ok: false, reason: "FILE_NAME" };

  return { ok: true, content: STICKER_CONTENT, attachments: [{ fileName, fileUrl }] };
};
