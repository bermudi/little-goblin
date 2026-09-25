import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTAGE_NOTICE_AFTER_MS, OutageTracker } from "./memory-outage.ts";

const dirs: string[] = [];
// A tracker over a fresh database with a mutable clock.
function makeTracker(): { t: OutageTracker; tick: (ms: number) => void; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "goblin-outage-test-"));
	dirs.push(dir);
	const path = join(dir, "state.sqlite");
	let now = 1_000_000;
	const t = new OutageTracker(new Database(path), () => now);
	return { t, tick: (ms) => (now += ms), path };
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
		tick(OUTAGE_NOTICE_AFTER_MS - 1);
		expect(t.recordFailure("topic:1:2")).toBeNull(); // just under
		tick(1);
		const notice = t.recordFailure("topic:1:2"); // over
		expect(notice).not.toBeNull();
		expect(notice?.conversation).toBe("topic:1:2");
		expect(notice?.sinceMs).toBe(OUTAGE_NOTICE_AFTER_MS);
		t.markNotified();
		tick(60_000);
		expect(t.recordFailure("topic:1:2")).toBeNull(); // sent — stays quiet
	});

	test("an unconfirmed send keeps returning the notice (retry on next failure)", () => {
		const { t, tick } = makeTracker();
		t.recordFailure("dm:7");
		tick(OUTAGE_NOTICE_AFTER_MS + 1);
		expect(t.recordFailure("dm:7")).not.toBeNull(); // hypothetical send failed
		tick(300_000);
		expect(t.recordFailure("dm:7")).not.toBeNull(); // still unconfirmed
	});

	test("success clears the episode; a later failure starts a fresh one", () => {
		const { t, tick } = makeTracker();
		t.recordFailure("dm:7");
		tick(OUTAGE_NOTICE_AFTER_MS + 1);
		expect(t.recordFailure("dm:7")).not.toBeNull();
		t.recordSuccess();
		t.recordSuccess(); // idempotent — no episode is a no-op
		tick(1_000);
		expect(t.recordFailure("dm:7")).toBeNull(); // new episode, clock restarts
		tick(OUTAGE_NOTICE_AFTER_MS + 1);
		expect(t.recordFailure("dm:7")?.sinceMs).toBe(OUTAGE_NOTICE_AFTER_MS + 1);
	});

	test("episode state survives a restart", () => {
		const { t, tick, path } = makeTracker();
		t.recordFailure("topic:9:9");
		tick(OUTAGE_NOTICE_AFTER_MS + 1);
		t.markNotified();
		const reopened = new OutageTracker(new Database(path));
		expect(reopened.recordFailure("topic:9:9")).toBeNull(); // notified stands
	});
});
