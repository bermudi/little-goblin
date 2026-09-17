// Coalescing buffer — rapid-fire messages in one conversation merge into
// one turn. A message resets the quiet-window timer; when it fires, all
// buffered items flush as a single batch.

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

	pending(key: string): number {
		return this.buckets.get(key)?.items.length ?? 0;
	}

	private fire(key: string): void {
		const bucket = this.buckets.get(key);
		if (!bucket) return;
		this.buckets.delete(key);
		this.flush(key, bucket.items);
	}
}
