import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OWNER = "src/timing.ts";
const RAW_TIMER_RE =
	/(?:\bglobalThis\.|(?<![\w.$]))(?:set(?:Timeout|Interval)\s*\(|Bun\s*(?:\.\s*sleep\b|\[\s*(["'`])sleep\1\s*\]))/g;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) out.push(path);
	}
	return out;
}

function rawTimerSites(files: ReadonlyMap<string, string>): string[] {
	const out: string[] = [];
	for (const [file, text] of files) {
		if (file === OWNER) continue;
		const n = [...text.matchAll(RAW_TIMER_RE)].length;
		if (n > 0) out.push(`${file}: ${n} raw setTimeout/setInterval/Bun.sleep calls — use ${OWNER}`);
	}
	return out.sort();
}

function sourceFiles(): Map<string, string> {
	const files = new Map<string, string>();
	for (const file of walk(join(ROOT, "src"))) files.set(file.slice(ROOT.length + 1), readFileSync(file, "utf8"));
	return files;
}

describe("timer guard", () => {
	test("no file outside src/timing.ts calls a raw timer", () => {
		expect(rawTimerSites(sourceFiles())).toEqual([]);
	});

	test("the pattern counts global timers and Bun.sleep, not socket timers or similar names", () => {
		const sample = [
			"const t = setTimeout(fn, 10);",
			"setInterval(tick, 5)",
			"connection.setTimeout(15_000, onIdle);",
			"globalThis.setTimeout(fn, 1);",
			"await Bun.sleep(50);",
			"globalThis.Bun.sleep(1);",
			"const s = Bun.sleep;",
			"await Bun .sleep(1);",
			"await Bun\n\t.sleep(1);",
			'Bun["sleep"](1);',
			"Bun[ 'sleep' ](1);",
			'Bun["sleepSync"](1);',
			"myBun.sleep(1);",
			"Bun.sleepSync(1);",
			"clearTimeout(t);",
		].join("\n");
		expect([...sample.matchAll(RAW_TIMER_RE)].map((m) => m[0])).toEqual([
			"setTimeout(",
			"setInterval(",
			"globalThis.setTimeout(",
			"Bun.sleep",
			"globalThis.Bun.sleep",
			"Bun.sleep",
			"Bun .sleep",
			"Bun\n\t.sleep",
			'Bun["sleep"]',
			"Bun[ 'sleep' ]",
		]);
	});

	test("the guard fails on a new raw timer and spares the owner", () => {
		expect(
			rawTimerSites(
				new Map([
					["src/new-module.ts", "setTimeout(fn, 1); Bun.sleep(1);"],
					[OWNER, "setInterval(fn, 1); Bun.sleep(1);"],
				]),
			),
		).toEqual([`src/new-module.ts: 2 raw setTimeout/setInterval/Bun.sleep calls — use ${OWNER}`]);
	});
});
