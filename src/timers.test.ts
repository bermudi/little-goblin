import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OWNER = "src/timing.ts";
const RAW_TIMER_RE = /(?:\bglobalThis\.|(?<![\w.$]))set(?:Timeout|Interval)\s*\(/g;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) out.push(path);
	}
	return out;
}

function liveCounts(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const file of walk(join(ROOT, "src"))) {
		const rel = file.slice(ROOT.length + 1);
		if (rel === OWNER) continue;
		const n = [...readFileSync(file, "utf8").matchAll(RAW_TIMER_RE)].length;
		if (n > 0) counts.set(rel, n);
	}
	return counts;
}

function rawTimerGrowth(
	live: ReadonlyMap<string, number>,
	frozen: Readonly<Record<string, number>>,
): string[] {
	const out: string[] = [];
	for (const [file, n] of live) {
		const allowed = frozen[file] ?? 0;
		if (n > allowed) out.push(`${file}: ${n} raw setTimeout/setInterval calls, frozen at ${allowed} — use ${OWNER}`);
	}
	return out.sort();
}

function printed(live: ReadonlyMap<string, number>): string {
	return [...live]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([f, n]) => `\t"${f}": ${n},`)
		.join("\n");
}

describe("timer guard", () => {
	test("no file outside src/timing.ts gains a raw timer", () => {
		const live = liveCounts();
		if (process.env.GOBLIN_PRINT_RAW_TIMERS === "1") process.stderr.write(`raw timers:\n${printed(live)}\n`);
		expect(rawTimerGrowth(live, FROZEN)).toEqual([]);
	});

	test("a file that moved onto src/timing.ts leaves the allowlist", () => {
		const live = liveCounts();
		const stale = Object.entries(FROZEN)
			.filter(([file, n]) => (live.get(file) ?? 0) < n)
			.map(([file, n]) => `${file}: frozen at ${n}, now ${live.get(file) ?? 0}`);
		expect(stale).toEqual([]);
	});

	test("the pattern counts global timers, not socket timers", () => {
		const sample = [
			"const t = setTimeout(fn, 10);",
			"setInterval(tick, 5)",
			"connection.setTimeout(15_000, onIdle);",
			"globalThis.setTimeout(fn, 1);",
			"clearTimeout(t);",
		].join("\n");
		expect([...sample.matchAll(RAW_TIMER_RE)]).toHaveLength(3);
	});

	test("the guard fails on a new raw timer", () => {
		expect(rawTimerGrowth(new Map([["src/new-module.ts", 1]]), {})).toEqual([
			`src/new-module.ts: 1 raw setTimeout/setInterval calls, frozen at 0 — use ${OWNER}`,
		]);
		expect(rawTimerGrowth(new Map([["src/scheduler.ts", 3]]), { "src/scheduler.ts": 2 })).toHaveLength(1);
	});
});

const FROZEN: Readonly<Record<string, number>> = {
	"src/health/t3.ts": 1,
	"src/http/app-sse.ts": 1,
	"src/http/app-turns.ts": 1,
	"src/idle-compaction.ts": 1,
	"src/index.ts": 2,
	"src/mail-approval.ts": 1,
	"src/memory/hindsight.ts": 1,
	"src/memory/mod.ts": 1,
	"src/proc.ts": 2,
	"src/reviewer.ts": 1,
	"src/rolling.ts": 1,
	"src/scheduler.ts": 2,
	"src/system1.ts": 2,
	"src/test-memory-net.worker.ts": 1,
	"src/testkit/memory-net/calm.fixture.ts": 1,
	"src/tg/deadline.ts": 1,
	"src/tg/delivery-files.ts": 1,
	"src/tg/delivery-voice.ts": 2,
	"src/tg/delivery.ts": 3,
	"src/tg/guest.ts": 1,
	"src/tg/refusals.ts": 1,
	"src/tg/speak-button.ts": 1,
};
