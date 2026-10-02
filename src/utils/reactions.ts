import { Types } from "mongoose";
import { idString } from "./ids";

/**
 * Reactions (worktrees/CHAT-CONTRACT.md §3), as pure functions. One reaction
 * per person per message, from a fixed set of six; REACT_MESSAGE
 * (socket/handlers.ts) is the only writer.
 */

/** The set, in the order every client shows it. Compared as exact strings: "❤️" is U+2764 U+FE0F. */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

export type Reaction = (typeof REACTIONS)[number];

export const isReaction = (value: unknown): value is Reaction =>
  typeof value === "string" && (REACTIONS as readonly string[]).includes(value);

/** REACT_MESSAGE events a socket may send per window (CHAT-CONTRACT.md §3.3). */
export const REACTION_RATE = { limit: 10, windowMs: 10_000 } as const;

/** A reaction as stored: `user` an ObjectId, `at` a Date. */
export interface StoredReaction {
  user?: unknown;
  emoji?: unknown;
  at?: unknown;
}

/** A reaction as the socket sends it (CHAT-CONTRACT.md §3.4). */
export interface ReactionView {
  user: string;
  emoji: string;
  at: string | null;
}

/** The fields of a stored message REACT_MESSAGE reads. */
export interface ReactionTarget {
  _id?: unknown;
  conversation?: unknown;
  sender?: unknown;
  messageType?: unknown;
  isDeleted?: unknown;
  isOrderMessage?: unknown;
}

/** Why a message cannot take a reaction; logged as `reaction_refused`. */
export type ReactionTargetProblem = "DELETED" | "ORDER_MESSAGE" | "SERVER_MESSAGE";

/** SYSTEM and the ORDER_* types: the service's own messages (utils/message-type.ts). */
export const isServerMessageType = (messageType: unknown): boolean =>
  typeof messageType === "string" && (messageType === "SYSTEM" || messageType.startsWith("ORDER_"));

/**
 * Why `target` cannot take a reaction, or null when it can: not deleted, not
 * an order message, and not a SYSTEM or ORDER_* type.
 */
export const reactionTargetProblem = (target: ReactionTarget): ReactionTargetProblem | null => {
  if (target.isDeleted === true) return "DELETED";
  if (target.isOrderMessage === true) return "ORDER_MESSAGE";
  if (isServerMessageType(target.messageType)) return "SERVER_MESSAGE";
  return null;
};

/**
 * The one write (CHAT-CONTRACT.md §3.3), as an update pipeline:
 *
 *   reactions = filter(reactions, user ≠ me) ++ (emoji ? [{ user: me, emoji, at }] : [])
 *
 * A message with no reactions yet counts as an empty list. Run with
 * `timestamps: false` (services/reactions.ts): a reaction is not an edit, and
 * nothing else on the message or its conversation moves.
 */
export const reactionUpdate = (userId: string, emoji: Reaction | null, at: Date): Record<string, unknown>[] => {
  const user = new Types.ObjectId(userId);
  return [
    {
      $set: {
        reactions: {
          $concatArrays: [
            {
              $filter: {
                input: { $ifNull: ["$reactions", []] },
                as: "reaction",
                cond: { $ne: ["$$reaction.user", user] },
              },
            },
            emoji === null ? [] : [{ user, emoji: { $literal: emoji }, at }],
          ],
        },
      },
    },
  ];
};

/** What `reactionUpdate` leaves, computed from the list it ran on. */
export const applyReaction = (
  before: StoredReaction[] | null | undefined,
  userId: string,
  emoji: Reaction | null,
  at: Date
): StoredReaction[] => [
  ...(Array.isArray(before) ? before : []).filter((reaction) => idString(reaction?.user) !== userId),
  ...(emoji === null ? [] : [{ user: new Types.ObjectId(userId), emoji, at }]),
];

/** `userId`'s emoji in `reactions`, or null. */
export const reactionOf = (reactions: StoredReaction[] | null | undefined, userId: string): string | null => {
  const mine = (Array.isArray(reactions) ? reactions : []).find((reaction) => idString(reaction?.user) === userId);
  return typeof mine?.emoji === "string" ? mine.emoji : null;
};

const isoOf = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** The list as the socket sends it: `user` a string, `at` ISO. Entries without a user or an emoji are left out. */
export const reactionViews = (reactions: StoredReaction[] | null | undefined): ReactionView[] =>
  (Array.isArray(reactions) ? reactions : []).flatMap((reaction) => {
    const user = idString(reaction?.user);
    if (!user || typeof reaction?.emoji !== "string") return [];
    return [{ user, emoji: reaction.emoji, at: isoOf(reaction.at) }];
  });

/**
 * A sliding-window limiter over `times` (the accepted events' timestamps,
 * kept on the socket): true and recorded when fewer than `limit` were
 * accepted in the last `windowMs`, false otherwise. Refused events are not
 * recorded, so a client that keeps hammering is let through again once its
 * accepted ones age out.
 */
export const allowInWindow = (times: number[], now: number, limit: number, windowMs: number): boolean => {
  while (times.length > 0 && times[0] <= now - windowMs) times.shift();
  if (times.length >= limit) return false;
  times.push(now);
  return true;
};
