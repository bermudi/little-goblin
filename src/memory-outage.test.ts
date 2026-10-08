import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTAGE_NOTICE_AFTER_MS, OUTAGE_STALE_AFTER_MS, OutageTracker } from "./memory-outage.ts";

const dirs: string[] = [];
// A tracker over a fresh database with a mutable clock.
function makeTracker(): {
	t: OutageTracker;
	tick: (ms: number) => void;
	path: string;
} {
	const dir = mkdtempSync(join(tmpdir(), "goblin-outage-test-"));
	dirs.push(dir);
	const path = join(dir, "state.sqlite");
	let now = 1_000_000;
	const t = new OutageTracker(new Database(path), () => now);
	return { t, tick: (ms) => (now += ms), path };
}
// Advance the clock in outage cadence — a failure every ~5min, the
// worker's worst-case retry gap. Teleporting the clock an hour in one
// jump would (correctly) trip the stale-episode reset instead.
function elapse(
	t: OutageTracker,
	tick: (ms: number) => void,
	conversation: string,
	ms: number,
): { conversation: string; sinceMs: number; episode: number } | null {
	let result: { conversation: string; sinceMs: number; episode: number } | null = null;
	let remaining = ms;
	const step = 5 * 60 * 1000;
	while (remaining > 0) {
		const d = Math.min(step, remaining);
		remaining -= d;
		tick(d);
		result = t.recordFailure(conversation);
	}
	return result;
}
process.on("exit", () => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("outage tracker", () => {
	test("first failure starts the episode; nothing is due yet", () => {
		const { t } = makeTracker();
		expect(t.recordFailure("topic:1:2")).toBeNull();
	});

	test("a notice is due exactly once per episode, after the threshold", () => {
		const { t, tick } = makeTracker();
		expect(t.recordFailure("topic:1:2")).toBeNull();
		expect(elapse(t, tick, "topic:1:2", OUTAGE_NOTICE_AFTER_MS - 1_000)).toBeNull(); // just under
		const notice = elapse(t, tick, "topic:1:2", 2_000); // over
		expect(notice).not.toBeNull();
		expect(notice?.conversation).toBe("topic:1:2");
		expect(notice?.sinceMs ?? 0).toBeGreaterThanOrEqual(OUTAGE_NOTICE_AFTER_MS);
		t.markNotified(notice?.episode ?? -1);
		tick(60_000);
		expect(t.recordFailure("topic:1:2")).toBeNull(); // sent — stays quiet
	});

	test("an unconfirmed send keeps returning the notice (retry on next failure)", () => {
		const { t, tick } = makeTracker();
		t.recordFailure("dm:7");
		expect(elapse(t, tick, "dm:7", OUTAGE_NOTICE_AFTER_MS + 1_000)).not.toBeNull();
		tick(300_000); // well under the stale gap
		expect(t.recordFailure("dm:7")).not.toBeNull(); // still unconfirmed
	});

	test("success clears the episode; a later failure starts a fresh one", () => {
		const { t, tick } = makeTracker();
		t.recordFailure("dm:7");
		expect(elapse(t, tick, "dm:7", OUTAGE_NOTICE_AFTER_MS + 1_000)).not.toBeNull();
		t.recordSuccess();
		t.recordSuccess(); // idempotent — no episode is a no-op
		expect(t.recordFailure("dm:7")).toBeNull(); // new episode, clock restarts
		expect(elapse(t, tick, "dm:7", OUTAGE_NOTICE_AFTER_MS + 1_000)).not.toBeNull();
	});

	test("a stale episode never makes a fresh outage notify instantly", () => {
		const { t, tick } = makeTracker();
		t.recordFailure("dm:7");
		// Outbox emptied via cancellation: no success ever observed, no
		// failure for weeks (gap far beyond OUTAGE_STALE_AFTER_MS).
		tick(21 * 24 * 60 * 60 * 1000);
		expect(t.recordFailure("dm:7")).toBeNull(); // episode reset, not instant notice
		expect(elapse(t, tick, "dm:7", OUTAGE_NOTICE_AFTER_MS - 1_000)).toBeNull(); // fresh threshold applies
		const notice = elapse(t, tick, "dm:7", 2_000);
		expect(notice?.sinceMs ?? 0).toBeGreaterThanOrEqual(OUTAGE_NOTICE_AFTER_MS);
	});

	test("a mark is scoped to its episode — a late mark cannot mute a successor", () => {
		const { t, tick } = makeTracker();
		t.recordFailure("dm:7");
		const old = elapse(t, tick, "dm:7", OUTAGE_NOTICE_AFTER_MS + 1_000);
		expect(old).not.toBeNull();
		// The send for `old` is still in flight when the service briefly
		// recovers (episode cleared) and a NEW outage begins and crosses
		// its threshold — then the old send finally resolves.
		t.recordSuccess();
		t.recordFailure("dm:7");
		const fresh = elapse(t, tick, "dm:7", OUTAGE_NOTICE_AFTER_MS + 1_000);
		expect(fresh).not.toBeNull();
		expect(fresh?.episode).not.toBe(old?.episode);
		t.markNotified(old?.episode ?? -1); // the late mark
		tick(60_000);
		expect(t.recordFailure("dm:7")).not.toBeNull(); // successor still speaks
	});

	test("episode state survives a restart", () => {
		const { t, tick, path } = makeTracker();
		t.recordFailure("topic:9:9");
		const episode = elapse(t, tick, "topic:9:9", OUTAGE_NOTICE_AFTER_MS + 1_000)?.episode;
		t.markNotified(episode ?? -1);
		const reopened = new OutageTracker(new Database(path));
		tick(60_000);
		expect(reopened.recordFailure("topic:9:9")).toBeNull(); // notified stands
	});
});
