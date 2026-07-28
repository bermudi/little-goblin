/**
 * Process-wide async transition lock for binding-changing lifecycle operations.
 *
 * Project assignment, `/resume`, and other Conversation-binding mutations share
 * this lock so they serialize validation, intent persistence, and binding writes
 * across the whole process. A single runtime queue is insufficient because an
 * unbound Surface has no runtime to queue behind.
 *
 * The lock is reentrant: an operation already running under the lock can call
 * `withLifecycleTransitionLock` again without deadlocking. This lets
 * higher-level lifecycle helpers (`resolve`, `createForSurface`, etc.) compose
 * freely while remaining individually lockable.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const lockStore = new AsyncLocalStorage<boolean>();
let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` serialized with every other lifecycle transition. The lock covers
 * the whole callback; the next caller waits until the returned promise settles.
 */
export function withLifecycleTransitionLock<T>(fn: () => T | Promise<T>): Promise<T> {
  if (lockStore.getStore()) {
    return Promise.resolve().then(fn) as Promise<T>;
  }
  const result = tail.then(() => lockStore.run(true, fn));
  tail = result.catch(() => {});
  return result as Promise<T>;
}
