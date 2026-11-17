// The engine → CLI steer channel: the query's input stays open while a
// turn runs, and each folded steer is pushed as one more user message.
// The vendor adapter (mod.ts) reads it as an async iterable; the fake
// query drains it synchronously. close() ends the iterable, so the
// child sees its input end when the turn does.

import type { ClaudeSteer, SteerChannel } from "./translate.ts";

export function steerChannel(): SteerChannel {
	const queue: ClaudeSteer[] = [];
	let closed = false;
	let wake: (() => void) | null = null;
	const notify = (): void => {
		const w = wake;
		wake = null;
		w?.();
	};
	return {
		push(steer) {
			if (closed) throw new Error("steer pushed after the claude query input closed");
			queue.push(steer);
			notify();
		},
		drain() {
			return queue.splice(0);
		},
		close() {
			closed = true;
			notify();
		},
		async *[Symbol.asyncIterator]() {
			for (;;) {
				const next = queue.shift();
				if (next !== undefined) {
					yield next;
					continue;
				}
				if (closed) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		},
	};
}
