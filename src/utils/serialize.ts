/**
 * In-process queues, one per key: a task starts when every task queued before
 * it under the same key has settled. The message controllers queue each send
 * under its conversation, so one process stores a conversation's messages one
 * at a time, in the order they came (an album, then its caption), instead of
 * racing on the conversation document. Another instance's sends are not
 * queued here; utils/transaction.ts retries the conflicts those cause.
 */

/** How long a task waits for the one before it before it goes anyway: a stuck task never blocks its key for good. */
export const SERIALIZE_MAX_WAIT_MS = 15_000;

/** Each key's last queued task, settled either way. Deleted once that task settles with nothing queued after it. */
const tails = new Map<string, Promise<void>>();

/** Resolves when `previous` settles, or after `ms`, whichever comes first. */
const settledOrTimedOut = (previous: Promise<void>, ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void previous.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });

const forget = (key: string, tail: Promise<void>): void => {
  if (tails.get(key) === tail) tails.delete(key);
};

/**
 * Queues `task` under `key` and resolves or rejects as it does. Its place in
 * the queue is taken when this is called, not when the task starts. A task
 * that rejects does not stop the ones after it.
 */
export const serialize = <T>(key: string, task: () => Promise<T>, maxWaitMs: number = SERIALIZE_MAX_WAIT_MS): Promise<T> => {
  const previous = tails.get(key);
  const run = (previous ? settledOrTimedOut(previous, maxWaitMs) : Promise.resolve()).then(() => task());
  const tail: Promise<void> = run.then(
    () => forget(key, tail),
    () => forget(key, tail)
  );
  tails.set(key, tail);
  return run;
};

/** How many keys have a task queued or running (for tests). */
export const queuedKeys = (): number => tails.size;
