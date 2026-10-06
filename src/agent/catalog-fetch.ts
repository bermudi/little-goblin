// The cached-catalog skeleton shared by the model catalogs in
// models-dev.ts: single-flight fetch, backoff on failure, TTL on success,
// validated disk cache under the backoff. A spec supplies the wire/disk
// shapes and the path; this module owns the fetch/cache/backoff timing so
// a third catalog can't fork it (DESIGN.md, catalog-fetch entry).

import { readFileSync } from "node:fs";
import { durableWriteFile } from "../durable.ts";
import { log } from "../log.ts";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Backoff after any failure — an unreachable endpoint must not be hit on
// every call (the intake chain is serial; a timeout per call would stall
// it).
const RETRY_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface CatalogSpec<T> {
	/** Log-line name — "models.dev", "openrouter catalog". */
	name: string;
	url: string;
	/** Resolved per read/write: tests retarget GOBLIN_HOME after import. */
	cachePath(): string;
	/** Warn-line tail for a failed fetch, naming the degradation. */
	staleNote: string;
	/** Wire JSON → in-memory shape. Throws on a wrong shape. */
	parseWire(wire: unknown): T;
	/** Disk JSON → in-memory shape. Throws on a wrong shape. */
	parseDisk(disk: unknown): T;
	/** In-memory shape → JSON value for the cache write. */
	toDisk(catalog: T): unknown;
}

export interface CachedCatalog<T> {
	/** Shared-flight fetch honoring the backoff and TTL. */
	ensure(): Promise<T | null>;
	/** Current value without kicking a fetch. */
	current(): T | null;
	/** True while the failure backoff keeps ensure() off the network. */
	backoffArmed(): boolean;
	/** Set the value and arm the TTL — test/boot priming, no network. */
	prime(catalog: T | null): void;
	/** Cold value, cleared backoff and flight — next ensure hits the network. */
	resetForTest(): void;
	/** Validated disk read, no network. Null when absent/invalid/unreadable. */
	readDisk(): T | null;
}

export function createCachedCatalog<T>(spec: CatalogSpec<T>): CachedCatalog<T> {
	let value: T | null = null;
	// Don't hit the network before this time. A successful fetch sets it a
	// day out; any failure leaves the backoff armed.
	let nextFetchAt = 0;
	// Concurrent callers share one fetch.
	let inflight: Promise<T | null> | null = null;

	// Disk state is a boundary — validated on read, never trusted. ENOENT
	// just means no cache; a wrong-shape file (hand edit, partial write,
	// future format change) degrades to null with a warn line, not a
	// silent null or a blind cast (the old openrouter cast happily built
	// Sets of characters out of a params string).
	function readDisk(): T | null {
		let raw: string;
		try {
			raw = readFileSync(spec.cachePath(), "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				log.warn(`${spec.name} cache unreadable — ignoring`, { error: String(err) });
			}
			return null;
		}
		try {
			return spec.parseDisk(JSON.parse(raw) as unknown);
		} catch (err) {
			// Wrong shape degrades with a line — the log bar: a symptom
			// here must not need a REPL to explain.
			log.warn(`${spec.name} cache invalid — ignoring`, { error: String(err) });
			return null;
		}
	}

	async function refresh(): Promise<T | null> {
		// Arm the backoff first — a failure anywhere below must not send
		// the next caller straight back to the network.
		nextFetchAt = Date.now() + RETRY_MS;
		try {
			const res = await fetch(spec.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			if (!res.ok) throw new Error(`${spec.name} HTTP ${res.status}`);
			const parsed = spec.parseWire(await res.json());
			value = parsed;
			nextFetchAt = Date.now() + CACHE_TTL_MS;
			try {
				durableWriteFile(spec.cachePath(), JSON.stringify(spec.toDisk(parsed)));
			} catch (err) {
				log.warn(`${spec.name} cache write failed`, { error: String(err) });
			}
			return value;
		} catch (err) {
			log.warn(`${spec.name} fetch failed — ${spec.staleNote}`, { error: String(err) });
			// In-memory value first; the disk cache covers a cold start.
			if (value) return value;
			value = readDisk();
			return value;
		}
	}

	return {
		// Join an in-flight fetch before consulting the backoff — refresh
		// arms the backoff synchronously on entry, so a nextFetchAt-first
		// order hands same-tick callers a cold null instead of the shared
		// flight.
		ensure() {
			if (inflight) return inflight;
			if (Date.now() < nextFetchAt) return Promise.resolve(value);
			inflight = refresh().finally(() => {
				inflight = null;
			});
			return inflight;
		},
		current: () => value,
		backoffArmed: () => Date.now() < nextFetchAt,
		prime(catalog) {
			value = catalog;
			nextFetchAt = Date.now() + CACHE_TTL_MS;
		},
		// The ensure path returns an in-flight promise before any other
		// check — a reset that left one armed would serve it stale.
		resetForTest() {
			value = null;
			nextFetchAt = 0;
			inflight = null;
		},
		readDisk,
	};
}
