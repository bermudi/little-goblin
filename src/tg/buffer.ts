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
			attempts: number;
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
				attempts: 0,
			});
		}
	}

	// Flush every pending bucket now — shutdown calls this so buffered
	// input reaches history instead of dying in memory with the process.
	drain(): void {
		let failed = 0;
		for (const [key, bucket] of [...this.buckets]) {
			clearTimeout(bucket.timer);
			clearTimeout(bucket.maxTimer);
			if (!this.fire(key)) failed++;
		}
		if (failed > 0) throw new Error(`buffer drain failed for ${failed} conversations — messages retained for retry`);
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

	private fire(key: string): boolean {
		const bucket = this.buckets.get(key);
		if (!bucket) return true;
		clearTimeout(bucket.timer);
		clearTimeout(bucket.maxTimer);
		this.buckets.delete(key);
		// fire() runs in a timer — a throwing flush would escape as an
		// uncaught exception and kill the process mid-update.
		try {
			this.flush(key, bucket.items);
			return true;
		} catch (err) {
			// submit did not admit this batch. Restore it before any new
			// arrivals (including a reentrant push during flush), then
			// retry; a timer failure must never discard acknowledged input.
			const newer = this.buckets.get(key);
			if (newer) {
				clearTimeout(newer.timer);
				clearTimeout(newer.maxTimer);
			}
			const retryMs = Math.max(this.windowMs, 1_000);
			this.buckets.set(key, {
				items: [...bucket.items, ...(newer?.items ?? [])],
				timer: setTimeout(() => this.fire(key), retryMs),
				maxTimer: setTimeout(() => this.fireMax(key), Math.max(retryMs, this.maxWaitMs)),
				firstAt: bucket.firstAt,
				attempts: bucket.attempts + 1,
			});
			log.error("buffer flush failed — batch retained for retry", err, {
				key, items: bucket.items.length, attempts: bucket.attempts + 1, retryMs,
			});
			return false;
		}
	}
}
