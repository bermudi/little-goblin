// Coalescing buffer — rapid-fire messages in one conversation merge into
// one turn. A message resets the quiet-window timer; when it fires, all
// buffered items flush as a single batch. The quiet window alone is
// unbounded — a source dribbling messages faster than the window resets
// it forever — so the first push also arms a max-wait ceiling that flushes
// without a quiet gap, warn-logged with the wait.

import { log } from "../log.ts";

export class CoalescingBuffer<T> {
	private buckets = new Map<
		string,
		{
			items: T[];
			timer: ReturnType<typeof setTimeout>;
			maxTimer: ReturnType<typeof setTimeout>;
			firstAt: number;
		}
	>();

	constructor(
		private windowMs: number,
		private flush: (key: string, items: T[]) => void,
		private maxWaitMs: number = windowMs * 4,
	) {}

	push(key: string, item: T): void {
		const existing = this.buckets.get(key);
		if (existing) {
			// Quiet window resets; the ceiling from the first push stands.
			clearTimeout(existing.timer);
			existing.items.push(item);
			existing.timer = setTimeout(() => this.fire(key), this.windowMs);
		} else {
			this.buckets.set(key, {
				items: [item],
				timer: setTimeout(() => this.fire(key), this.windowMs),
				maxTimer: setTimeout(() => this.fireMax(key), this.maxWaitMs),
				firstAt: Date.now(),
			});
		}
	}

	// Flush every pending bucket now — shutdown calls this so buffered
	// input reaches history instead of dying in memory with the process.
	drain(): void {
		for (const [key, bucket] of [...this.buckets]) {
			clearTimeout(bucket.timer);
			clearTimeout(bucket.maxTimer);
			this.fire(key);
		}
	}

	private fireMax(key: string): void {
		const bucket = this.buckets.get(key);
		if (!bucket) return;
		log.info("coalescing buffer max-wait — flushing without quiet window", {
			key,
			items: bucket.items.length,
			waitedMs: Date.now() - bucket.firstAt,
		});
		clearTimeout(bucket.timer);
		this.fire(key);
	}

	private fire(key: string): void {
		const bucket = this.buckets.get(key);
		if (!bucket) return;
		clearTimeout(bucket.maxTimer);
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
