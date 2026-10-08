// Coalescing buffer — rapid-fire messages in one conversation merge into
// one turn. A message resets the quiet-window timer; when it fires, all
// buffered items flush as a single batch. The quiet window alone is
// unbounded — a source dribbling messages faster than the window resets
// it forever — so the first push also arms a max-wait ceiling that flushes
// without a quiet gap, warn-logged with the wait.
//
// Flushes may be sync or async (a rolling-DM flush can await the
// follow-up check): a returned promise is tracked as in-flight work.
// A rejected promise is treated exactly like a sync throw — the batch
// is retained and retried on the same backoff ladder. Per key, flushes
// serialize: while a key's flush is in flight, that key's next bucket
// does not fire until it settles (it fires immediately after if its
// timer already elapsed — the follow-up check's deadline must not
// extend the burst's wait past maxWait). flush() is on the hook to
// stay single-threaded-safe per key; the buffer guarantees it.
//
// Retained batches keep their firstAt (the clock measures the oldest
// item's age, not the latest attempt's) and are merged front-first
// with anything newer that arrived while the failed flush ran — a
// message sent during a failing flush must not overtake the batch it
// follows in the conversation.
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
	// Per-key async flush in flight — the next bucket for that key
	// waits on it. `deferred` marks a key whose timer already elapsed
	// during the in-flight flush: it fires the moment the flush settles.
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

	// Flush every pending bucket now, then wait out in-flight flushes —
	// shutdown calls this so buffered input reaches history instead of
	// dying in memory with the process. Async now: it also awaits every
	// flush a deferred timer started mid-drain, and throws after the
	// wait so a shutdown path learns which lanes are still owed a flush.
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
			// An async flush for this lane is still running — its settle
			// handler fires this bucket immediately after.
			this.deferred.add(key);
			return true;
		}
		clearTimeout(bucket.timer);
		clearTimeout(bucket.maxTimer);
		this.buckets.delete(key);
		// fire() runs in a timer — a throwing flush would escape as an
		// uncaught exception and kill the process mid-update.
		let result: void | Promise<void>;
		try {
			result = this.flush(key, bucket.items);
		} catch (err) {
			// submit did not admit this batch. Restore it before any new
			// arrivals (including a reentrant push during flush), then
			// retry; a timer failure must never discard acknowledged input.
			this.retain(key, bucket, err);
			return false;
		}
		if (result === undefined || result === null) return true;
		const p = Promise.resolve(result).then(
			(): boolean => true,
			(err: unknown): boolean => {
				// An async rejection is the same failure a sync throw was —
				// the batch is retained and retried on the backoff ladder.
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

	// A failed flush retains its batch for retry: the bucket goes back,
	// merged front-first with anything that arrived while the flush ran.
	// Consecutive failures back off exponentially — a persistently
	// failing flush (full disk, dead history file) must not hot-loop
	// once a second forever. Doubling from the base delay, capped at
	// five minutes; a successful flush deletes the bucket, so any
	// later batch starts the ladder over. The deferred flag is consumed
	// — the retry timer is the fire, so the backoff ladder is not
	// bypassed.
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
