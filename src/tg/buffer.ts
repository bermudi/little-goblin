import { log } from "../log.ts";

interface Bucket<T> {
	items: T[];
	timer: ReturnType<typeof setTimeout>;
	maxTimer: ReturnType<typeof setTimeout>;
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
				maxTimer: setTimeout(() => this.fireMax(key), this.maxWaitMs),
				firstAt: Date.now(),
				attempts: 0,
			});
		}
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
			clearTimeout(bucket.timer);
			clearTimeout(bucket.maxTimer);
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

	private fire(key: string): boolean | Promise<boolean> {
		const bucket = this.buckets.get(key);
		if (!bucket) return true;
		if (this.inflight.has(key)) {
			this.deferred.add(key);
			return true;
		}
		clearTimeout(bucket.timer);
		clearTimeout(bucket.maxTimer);
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
			if (this.deferred.delete(key)) this.fire(key);
		});
		return p;
	}

	private retain(key: string, bucket: Bucket<T>, err: unknown): void {
		const newer = this.buckets.get(key);
		if (newer) {
			clearTimeout(newer.timer);
			clearTimeout(newer.maxTimer);
		}
		this.deferred.delete(key);
		const attempts = bucket.attempts + 1;
		const retryMs = Math.min(Math.max(this.windowMs, 1_000) * 2 ** (attempts - 1), 300_000);
		this.buckets.set(key, {
			items: [...bucket.items, ...(newer?.items ?? [])],
			timer: setTimeout(() => this.fire(key), retryMs),
			maxTimer: setTimeout(() => this.fireMax(key), Math.max(retryMs, this.maxWaitMs)),
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
