// config-pins.ts boundary tests: bootPinnedDiffs is the one comparison
// behind the post-write warn lines AND the status card's restart hints
// — same keys, same order. wireConfigWrite owns the reconcile: hot-
// applies (log level, menu button), per-block flip lines, stranded-
// sandbox warn on removal, pin warns. Configs are REAL parsed fixtures
// (goblin.json5 through loadConfig); setLogWriter captures the lines.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, type ConfigRef, loadConfig } from "./config.ts";
import {
	type BootPins,
	bootPinnedDiffs,
	sandboxConfigured,
	wireConfigWrite,
} from "./config-pins.ts";
import { setLogFile, setLogWriter } from "./log.ts";
import { useHome } from "./testkit.ts";

const BASE = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7]}`;

function load(content: string): Config {
	const dir = useHome("goblin-pins-");
	writeFileSync(join(dir, "goblin.json5"), content);
	const c = loadConfig();
	if (c === null) throw new Error("fixture config did not parse");
	return c;
}
const loadExtra = (extra: string) => load(BASE.slice(0, -1) + `,${extra}}`);

function pinsFor(c: Config): BootPins {
	return {
		memory: c.memory,
		appToken: c.appToken,
		telegramEnabled: c.telegram.enabled,
		apiRoot: c.telegram.apiRoot,
		delegation: c.delegation,
		subagents: c.subagents,
		reviewer: c.reviewer,
	};
}

function capture(): { lines: string[]; stop: () => void } {
	const lines: string[] = [];
	setLogFile("config-pins-test.log");
	setLogWriter((_path, line) => lines.push(line));
	return {
		lines,
		stop: () => {
			setLogFile(null);
			setLogWriter(null);
		},
	};
}

function wire(boot: Config, cur: Config) {
	const calls = { menu: 0, stranded: 0 };
	const ref: ConfigRef = { current: cur, ttsDown: false };
	const w = wireConfigWrite({
		configRef: ref,
		boot,
		pins: pinsFor(boot),
		syncMenuButton: () => calls.menu++,
		warnStrandedSandboxes: () => calls.stranded++,
	});
	return { calls, ref, ...w };
}

describe("bootPinnedDiffs", () => {
	test("identical config diffs to nothing", () => {
		const c = loadExtra("");
		expect(bootPinnedDiffs(pinsFor(c), c)).toEqual([]);
	});

	test.each([
		["memory", `memory:{baseUrl:"http://127.0.0.1:8888",bankId:"b"}`, "memory"],
		["appToken", `appToken:"other"`, "appToken"],
		["telegram.enabled", `telegram:{enabled:false}`, "telegram.enabled"],
		["apiRoot", `telegram:{apiRoot:"http://127.0.0.1:9"}`, "telegram.apiRoot"],
		["delegation", `delegation:{harnesses:{a:{kind:"x"}}}`, "delegation"],
		["subagents", `subagents:{maxRuns:2}`, "subagents"],
		["reviewer", `reviewer:{auth:"openrouter"}`, "reviewer"],
	])("a %s change reports its key", (_label, extra, key) => {
		const boot = loadExtra("");
		expect(bootPinnedDiffs(pinsFor(boot), loadExtra(extra))).toEqual([key]);
	});

	test.each([
		["removal", ""],
		["auth", `reviewer:{auth:"other"}`],
		["threshold", `reviewer:{auth:"openrouter",threshold:0.6}`],
		["per-trigger thresholds", `reviewer:{auth:"openrouter",thresholds:{correction:0.9}}`],
		["queue cap", `reviewer:{auth:"openrouter",queueCap:2}`],
		["evidence", `reviewer:{auth:"openrouter",evidence:{calls:12}}`],
		["model", `reviewer:{auth:"openrouter",model:"zai/review"}`],
	])("reviewer %s requires restart", (_label, extra) => {
		const boot = loadExtra(`reviewer:{auth:"openrouter"}`);
		expect(bootPinnedDiffs(pinsFor(boot), loadExtra(extra))).toEqual(["reviewer"]);
	});

	test("multiple diffs report in pin order, not diff order", () => {
		const boot = loadExtra("");
		const cur = loadExtra(
			`subagents:{maxRuns:2},appToken:"other",memory:{baseUrl:"http://127.0.0.1:8888",bankId:"b"}`,
		);
		expect(bootPinnedDiffs(pinsFor(boot), cur)).toEqual(["memory", "appToken", "subagents"]);
	});
});

describe("sandboxConfigured", () => {
	test("an object block counts; an absent one does not", () => {
		expect(sandboxConfigured(loadExtra(`sandbox:{}`))).toBe(true);
		expect(sandboxConfigured(loadExtra(""))).toBe(false);
	});
});

describe("wireConfigWrite", () => {
	test("every write re-syncs the menu button", () => {
		const boot = loadExtra("");
		const w = wire(boot, loadExtra(""));
		w.onConfigWritten();
		w.onConfigWritten();
		expect(w.calls.menu).toBe(2);
	});

	test("a search flip logs once; a write without the flip stays silent", () => {
		const cap = capture();
		try {
			const boot = loadExtra("");
			const w = wire(boot, loadExtra(""));
			w.ref.current = loadExtra(`search:[{kind:"brave",auth:"b"}]`);
			w.onConfigWritten();
			w.onConfigWritten();
			expect(cap.lines.filter((l) => l.includes("search tool enabled"))).toHaveLength(1);
		} finally {
			cap.stop();
		}
	});

	test("a transcription removal logs the leave line", () => {
		const cap = capture();
		try {
			const boot = loadExtra(`transcription:{kind:"openai",auth:"o"}`);
			const w = wire(boot, loadExtra(`transcription:{kind:"openai",auth:"o"}`));
			w.ref.current = loadExtra("");
			w.onConfigWritten();
			expect(cap.lines.some((l) => l.includes("transcribe tool disabled"))).toBe(true);
		} finally {
			cap.stop();
		}
	});

	test("removing the sandbox block warns stranded once; re-adding does not", () => {
		const boot = loadExtra(`sandbox:{}`);
		const w = wire(boot, loadExtra(`sandbox:{}`));
		w.ref.current = loadExtra("");
		w.onConfigWritten();
		w.ref.current = loadExtra(`sandbox:{}`);
		w.onConfigWritten();
		expect(w.calls.stranded).toBe(1);
	});

	test("reviewer parking warns and needs restart until the boot block is restored", () => {
		const cap = capture();
		try {
			const boot = loadExtra(`reviewer:{auth:"openrouter",threshold:0.6,queueCap:2}`);
			const w = wire(boot, boot);
			w.ref.current = loadExtra(`parked:{reviewer:{auth:"openrouter",threshold:0.6,queueCap:2}}`);
			w.onConfigWritten();
			expect(cap.lines.some((l) => l.includes("reviewer config changed — restart to apply"))).toBe(
				true,
			);
			expect(w.restartHints()).toEqual(["reviewer"]);
			w.ref.current = boot;
			w.onConfigWritten();
			expect(w.restartHints()).toEqual([]);
		} finally {
			cap.stop();
		}
	});

	test("enabling reviewer reports a restart even though the block is now present", () => {
		const boot = loadExtra("");
		const w = wire(boot, loadExtra(`reviewer:{auth:"openrouter"}`));
		w.onConfigWritten();
		expect(w.restartHints()).toEqual(["reviewer"]);
	});

	test("a pin diff warns per key and restartHints reports the live read", () => {
		const cap = capture();
		try {
			const boot = loadExtra("");
			const w = wire(boot, loadExtra(""));
			w.ref.current = loadExtra(`appToken:"other"`);
			w.onConfigWritten();
			expect(cap.lines.some((l) => l.includes("appToken changed — restart to apply"))).toBe(true);
			expect(w.restartHints()).toEqual(["appToken"]);
			w.ref.current = loadExtra("");
			expect(w.restartHints()).toEqual([]);
		} finally {
			cap.stop();
		}
	});
});
