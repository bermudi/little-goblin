// Coalescing buffer — rapid-fire messages in one conversation merge into
// one turn. A message resets the quiet-window timer; when it fires, all
// buffered items flush as a single batch.

import { log } from "../log.ts";

export class CoalescingBuffer<T> {
	private buckets = new Map<string, { items: T[]; timer: ReturnType<typeof setTimeout> }>();

	constructor(
		private windowMs: number,
		private flush: (key: string, items: T[]) => void,
	) {}

	push(key: string, item: T): void {
		const existing = this.buckets.get(key);
		if (existing) {
			clearTimeout(existing.timer);
			existing.items.push(item);
			existing.timer = setTimeout(() => this.fire(key), this.windowMs);
		} else {
			this.buckets.set(key, {
				items: [item],
				timer: setTimeout(() => this.fire(key), this.windowMs),
			});
		}
	}

	// Flush every pending bucket now — shutdown calls this so buffered
	// input reaches history instead of dying in memory with the process.
	drain(): void {
		for (const [key, bucket] of [...this.buckets]) {
			clearTimeout(bucket.timer);
			this.fire(key);
		}
	}

	private fire(key: string): void {
		const bucket = this.buckets.get(key);
		if (!bucket) return;
		this.buckets.delete(key);
		// fire() runs in a timer — a throwing flush would escape as an
		// uncaught exception and kill the process mid-update.
		try {
			this.flush(key, bucket.items);
		} catch (err) {
			log.error("buffer flush failed", err, { key });
		}
	}
}
