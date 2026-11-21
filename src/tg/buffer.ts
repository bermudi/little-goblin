import { log } from "../log.ts";
import { after, type Timer } from "../timing.ts";

interface Bucket<T> {
	items: T[];
	timer: Timer;
	maxTimer: Timer;
	firstAt: number;
	attempts: number;
}

export class CoalescingBuffer<T> {
	private buckets = new Map<string, Bucket<T>>();
	private inflight = new Map<string, Promise<boolean>>();
	private deferred = new Set<string>();

	constructor(
		private windowMs: number,
		private flush: (key: string, items: T[]) => void | Promise<void>,
		private maxWaitMs: number = windowMs * 4,
	) {}

	// Returns true when this item started a new bucket — the intake ack
	// (one typing ping per buffer) keys off the empty → non-empty edge.
	push(key: string, item: T): boolean {
		const existing = this.buckets.get(key);
		if (existing) {
			existing.timer.cancel();
			existing.items.push(item);
			existing.timer = this.quiet(key, this.windowMs);
			return false;
		}
		this.buckets.set(key, {
			items: [item],
			timer: this.quiet(key, this.windowMs),
			maxTimer: this.cap(key, this.maxWaitMs),
			firstAt: Date.now(),
			attempts: 0,
		});
		return true;
	}

	amend(key: string, match: (item: T) => boolean, update: (item: T) => void): boolean {
		const bucket = this.buckets.get(key);
		if (bucket === undefined) return false;
		const item = bucket.items.find(match);
		if (item === undefined) return false;
		update(item);
		return true;
	}

	async drain(): Promise<void> {
		let failed = 0;
		const started = new Set<Promise<boolean>>();
		for (const [key, bucket] of [...this.buckets]) {
			bucket.timer.cancel();
			bucket.maxTimer.cancel();
			const r = this.fire(key);
			if (r === false) failed += 1;
			else if (r instanceof Promise) started.add(r);
		}
		while (this.inflight.size > 0 || started.size > 0) {
			const waits = [...new Set([...started, ...this.inflight.values()])];
			started.clear();
			for (const ok of await Promise.all(waits)) {
				if (!ok) failed += 1;
			}
		}
		if (failed > 0) {
			throw new Error(
				`buffer drain failed for ${failed} conversations — messages retained for retry`,
			);
		}
	}

	private quiet(key: string, ms: number): Timer {
		return after(ms, "buffer quiet window", () => this.fire(key));
	}

	private cap(key: string, ms: number): Timer {
		return after(ms, "buffer max wait", () => this.fireMax(key));
	}

	private fireMax(key: string): void {
		const bucket = this.buckets.get(key);
		if (!bucket) return;
		log.info("coalescing buffer max-wait — flushing without quiet window", {
			key,
			items: bucket.items.length,
			waitedMs: Date.now() - bucket.firstAt,
		});
		bucket.timer.cancel();
		const flush = this.fire(key);
		if (typeof flush !== "boolean")
			void flush.catch((err: unknown) =>
				log.error("buffer max-wait flush failed", err, { key }),
			);
	}

	private fire(key: string): boolean | Promise<boolean> {
		const bucket = this.buckets.get(key);
		if (!bucket) return true;
		if (this.inflight.has(key)) {
			this.deferred.add(key);
			return true;
		}
		bucket.timer.cancel();
		bucket.maxTimer.cancel();
		this.buckets.delete(key);
		let result: void | Promise<void>;
		try {
			result = this.flush(key, bucket.items);
		} catch (err) {
			this.retain(key, bucket, err);
			return false;
		}
		if (result === undefined || result === null) return true;
		const p = Promise.resolve(result).then(
			(): boolean => true,
			(err: unknown): boolean => {
				this.retain(key, bucket, err);
				return false;
			},
		);
		this.inflight.set(key, p);
		void p.finally(() => {
			this.inflight.delete(key);
			if (this.deferred.delete(key)) {
				const next = this.fire(key);
				if (typeof next !== "boolean")
					void next.catch((err: unknown) =>
						log.error("deferred buffer drain failed", err, { key }),
					);
			}
		}).catch((err: unknown) => log.error("buffer drain cleanup failed", err, { key }));
		return p;
	}

	private retain(key: string, bucket: Bucket<T>, err: unknown): void {
		const newer = this.buckets.get(key);
		if (newer) {
			newer.timer.cancel();
			newer.maxTimer.cancel();
		}
		this.deferred.delete(key);
		const attempts = bucket.attempts + 1;
		const retryMs = Math.min(Math.max(this.windowMs, 1_000) * 2 ** (attempts - 1), 300_000);
		this.buckets.set(key, {
			items: [...bucket.items, ...(newer?.items ?? [])],
			timer: this.quiet(key, retryMs),
			maxTimer: this.cap(key, Math.max(retryMs, this.maxWaitMs)),
			firstAt: bucket.firstAt,
			attempts,
		});
		log.error("buffer flush failed — batch retained for retry", err, {
			key,
			items: bucket.items.length,
			attempts,
			retryMs,
		});
	}
}
