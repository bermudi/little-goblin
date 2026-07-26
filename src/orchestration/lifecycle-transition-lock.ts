/**
 * Process-wide async transition lock for binding-changing lifecycle operations.
 *
 * Project assignment, `/resume`, and other Conversation-binding mutations share
 * this lock so they serialize validation, intent persistence, and binding writes
 * across the whole process. A single runtime queue is insufficient because an
 * unbound Surface has no runtime to queue behind.
 */

let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` serialized with every other lifecycle transition. The lock covers
 * the whole callback; the next caller waits until the returned promise settles.
 */
export function withLifecycleTransitionLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = tail.then(fn);
  tail = result.catch(() => {});
  return result;
}
