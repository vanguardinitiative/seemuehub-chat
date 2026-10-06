import mongoose from "mongoose";

/**
 * A send's transaction (controllers/message sendPrivateMessage and
 * sendGroupMessage), retried the way MongoDB's transaction spec says to.
 *
 * Every send writes the same conversation document (latestMessageData), so two
 * sends to one conversation at once - an album and its caption, sent
 * milliseconds apart - conflict: one of them gets a WriteConflict (code 112,
 * labelled TransientTransactionError) and used to fail with
 * MESSAGE_SEND_FAILED. utils/serialize.ts keeps one process's sends to a
 * conversation apart; this covers the rest (another instance, a read or
 * delivered mark landing on the conversation mid-send).
 */

/** How many times a send's transaction is run, the first time included. */
export const SEND_TRANSACTION_ATTEMPTS = 3;

/** How many times a commit whose outcome is unknown is tried, the first time included. */
const COMMIT_ATTEMPTS = 3;

/** 20–80 ms, so two sends that just conflicted do not meet again. */
const jitter = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 61)));

const hasErrorLabel = (error: unknown, label: string): boolean => {
  const labels = (error as { errorLabels?: unknown } | null | undefined)?.errorLabels;
  return Array.isArray(labels) && labels.includes(label);
};

/** A failure a fresh transaction can get past: another write to the same document got there first. */
export const isTransientTransactionError = (error: unknown): boolean =>
  hasErrorLabel(error, "TransientTransactionError") || (error as { code?: unknown } | null | undefined)?.code === 112;

/** Aborts a transaction; a failure to abort is logged, never thrown over the error that caused it. */
export const abortQuietly = async (session: mongoose.ClientSession): Promise<void> => {
  try {
    // After a commit was attempted the driver no longer counts the session as
    // in a transaction, and an abort would throw.
    if (typeof session.inTransaction !== "function" || session.inTransaction()) {
      await session.abortTransaction();
    }
  } catch (error) {
    console.error("Error aborting message transaction:", error instanceof Error ? error.message : "Unknown error");
  }
};

const endQuietly = async (session: mongoose.ClientSession): Promise<void> => {
  try {
    await session.endSession();
  } catch (error) {
    console.error("Error ending message session:", error instanceof Error ? error.message : "Unknown error");
  }
};

/**
 * The commit, tried again while its outcome is unknown
 * (UnknownTransactionCommitResult: the connection dropped, a failover). A
 * commit is safe to repeat; the work before it is not run again.
 */
const commitWithRetry = async (session: mongoose.ClientSession): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      await session.commitTransaction();
      return;
    } catch (error) {
      if (attempt >= COMMIT_ATTEMPTS || !hasErrorLabel(error, "UnknownTransactionCommitResult")) throw error;
      await jitter();
    }
  }
};

export interface SendTransactionOptions {
  /** Before each new run: the attempt about to start (2, 3) and the error that ended the last one. */
  onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * Runs `work` in a transaction on a fresh session and commits it; resolves to
 * what `work` returned, once committed. A transient failure (a write conflict)
 * aborts and runs `work` again on a new session, up to
 * SEND_TRANSACTION_ATTEMPTS times in all, 20–80 ms apart. Any other failure,
 * or the last transient one, is thrown after the abort. The session is always
 * ended.
 *
 * `work` may run more than once, so it must decide anything that has to stay
 * the same across runs (the message's `_id`) before it is called, and must
 * not publish anything: only the caller, after this resolves, knows the
 * writes were kept.
 */
export const withSendTransaction = async <T>(
  work: (session: mongoose.ClientSession, attempt: number) => Promise<T>,
  options: SendTransactionOptions = {}
): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const result = await work(session, attempt);
      await commitWithRetry(session);
      return result;
    } catch (error) {
      await abortQuietly(session);
      if (attempt >= SEND_TRANSACTION_ATTEMPTS || !isTransientTransactionError(error)) throw error;
      options.onRetry?.(attempt + 1, error);
    } finally {
      await endQuietly(session);
    }
    await jitter();
  }
};
