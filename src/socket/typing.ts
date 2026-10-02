/**
 * The typing indicator's server rules (worktrees/CHAT-CONTRACT.md §4.1), kept
 * per socket on `socket.data.typing` and free of Redis and Mongo. TYPING
 * writes nothing to the database: it reads membership (cached here) and
 * publishes.
 */

export const TYPING_RULES = {
  /** How long a socket trusts a "participant" answer, with the other participants it came with. */
  memberTtlMs: 10 * 60_000,
  /** How long a "not a participant" answer is kept, so a refused client cannot make every event a lookup. */
  nonMemberTtlMs: 60_000,
  /** At most one forwarded TYPING per conversation per socket in this long. */
  minIntervalMs: 1_000,
  /** Conversations a socket keeps state for before the oldest idle ones are forgotten. */
  maxConversations: 100,
} as const;

/** One socket's TYPING state for one conversation. */
export interface TypingEntry {
  /** Whether the caller is a participant, as of `checkedAt`. */
  member: boolean;
  /** The other participants: who hears this socket's TYPING. */
  others: string[];
  /** When membership was last looked up; null before the first lookup. */
  checkedAt: number | null;
  /**
   * The lookup in flight, so events that arrive meanwhile wait for it instead
   * of starting their own. Never rejects: false when the lookup failed.
   */
  pending?: Promise<boolean>;
  /** When a TYPING for this conversation was last forwarded, and what it said. */
  lastForwardedAt: number | null;
  typing: boolean;
}

export const newTypingEntry = (): TypingEntry => ({
  member: false,
  others: [],
  checkedAt: null,
  lastForwardedAt: null,
  typing: false,
});

/** Whether the cached membership answer has run out (or there is none). */
export const membershipExpired = (entry: TypingEntry, now: number): boolean => {
  if (entry.checkedAt === null) return true;
  const ttl = entry.member ? TYPING_RULES.memberTtlMs : TYPING_RULES.nonMemberTtlMs;
  return now - entry.checkedAt >= ttl;
};

/**
 * Whether a TYPING is forwarded: the first one, or one at least a second
 * after the last forwarded one. A `typing: false` always goes when the last
 * forwarded state was `true`, so the indicator is never left on by the
 * throttle. Everything else is dropped silently.
 */
export const typingPasses = (entry: TypingEntry, typing: boolean, now: number): boolean => {
  if (entry.lastForwardedAt === null) return true;
  if (typing === false && entry.typing === true) return true;
  return now - entry.lastForwardedAt >= TYPING_RULES.minIntervalMs;
};

/**
 * Keeps a socket's map bounded: before a new conversation is added to a full
 * map, the oldest entries that are not showing "typing" are forgotten (an
 * entry showing it is kept, so the disconnect can still clear it).
 */
export const makeRoomForTyping = (entries: Map<string, TypingEntry>): void => {
  if (entries.size < TYPING_RULES.maxConversations) return;
  for (const [conversationId, entry] of entries) {
    if (entries.size < TYPING_RULES.maxConversations) return;
    if (!entry.typing && !entry.pending) entries.delete(conversationId);
  }
};

/** The conversations a socket last reported `typing: true` in, with who to tell it stopped. */
export const stillTyping = (entries: Map<string, TypingEntry> | undefined): { conversationId: string; others: string[] }[] =>
  entries
    ? [...entries]
        .filter(([, entry]) => entry.typing && entry.member && entry.others.length > 0)
        .map(([conversationId, entry]) => ({ conversationId, others: [...entry.others] }))
    : [];
