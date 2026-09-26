// The system prompt is the head of the provider prefix cache — these tests
// guard the invariant from DESIGN.md (Cache stability): nothing in the
// prompt varies turn-to-turn on its own. A test failing here usually means
// someone added a clock, counter, or random value to the prompt.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config.ts";
import { setLogFile } from "../log.ts";
import type { Conversation } from "../conversation.ts";
import { _resetPromptSourcesForTest, buildSystemPrompt } from "./prompt.ts";

let dirs: string[] = [];
function useHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-prompt-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const conv: Conversation = {
	id: "dm-1",
	chatId: 1,
	threadId: null,
	title: null,
	titleImplicit: false,
	model: null,
	thinking: null,
	voice: false,
	memoryExcluded: false,
	epoch: 0,
	createdAt: new Date().toISOString(),
};

// The deployment's always-on set — as index.ts builds it without TTS.
const tools = ["read_file", "write_file", "edit_file", "bash", "program", "send_file"];

describe("buildSystemPrompt", () => {
	test("memory evidence is framed when the tool is present — and only then", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			const plain = buildSystemPrompt(conv, tools);
			expect(plain.text).toContain("your only\n  memory between them");
			expect(plain.text).not.toContain("Long-term memory is on");
			const withMemory = buildSystemPrompt(conv, [...tools, "memory_search"]);
			expect(withMemory.text).toContain("Long-term memory is on");
			expect(withMemory.text).toContain("memory_search");
			expect(withMemory.text).not.toContain("your only\n  memory between them");
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});
	test("no clock — the prompt carries no date and points at `date` instead", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			const { text } = buildSystemPrompt(conv, tools);
			// An ISO date anywhere in the prompt would invalidate the whole
			// prefix cache every midnight.
			expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
			expect(text).toContain("run `date` via");
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});

	test("stable across calls — same inputs, identical bytes", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			writeFileSync(paths.soul(), "You are goblin.");
			const a = buildSystemPrompt(conv, tools);
			const b = buildSystemPrompt(conv, tools);
			expect(a.text).toBe(b.text);
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});

	test("missing SOUL.md falls back to the default identity — loudly", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		const logFile = join(home, "goblin.log");
		setLogFile(logFile);
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			// No SOUL.md — deleted mid-run, never recreated.
			const { text } = buildSystemPrompt(conv, tools);
			expect(text).toContain("You are goblin, a personal AI agent.");
			const warned = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>)
				.some((l) => l.msg === "SOUL.md missing — default identity in use");
			// A silent personality swap is exactly what the log must explain.
			expect(warned).toBe(true);
		} finally {
			setLogFile(null);
			delete process.env.GOBLIN_HOME;
		}
	});

	test("an operator edit to a prompt source logs the cache boundary", () => {
		_resetPromptSourcesForTest();
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		const logFile = join(home, "goblin.log");
		setLogFile(logFile);
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			buildSystemPrompt(conv, tools); // primes the source hashes silently
			writeFileSync(join(paths.workspace(), "SOUL.md"), "an edited soul");
			buildSystemPrompt(conv, tools);
			const lines = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			// "operator edited" and "a bug moved the hash" must be
			// distinguishable in the log — the changed line names the file.
			const changed = lines.filter((l) => l.msg === "prompt source changed");
			expect(changed).toHaveLength(1);
			expect(changed[0]).toMatchObject({ source: "SOUL.md" });
			expect(changed[0]!.from).toBe("absent");
			expect(changed[0]!.to).not.toBe("absent");
		} finally {
			setLogFile(null);
			delete process.env.GOBLIN_HOME;
		}
	});
	describe("tool list", () => {
		test("rendered verbatim from the wiring; program prose gated on presence", () => {
			const home = useHome();
			process.env.GOBLIN_HOME = home;
			try {
				const full = buildSystemPrompt(conv, [
					"read_file",
					"write_file",
					"edit_file",
					"bash",
					"speak",
					"program",
					"send_file",
				]);
				expect(full.text).toContain(
					"Tools: read_file, write_file, edit_file, bash, speak, program, send_file.",
				);
				expect(full.text).toContain("create one only when");

				const bare = buildSystemPrompt(conv, ["read_file", "bash"]);
				expect(bare.text).toContain("Tools: read_file, bash.");
				expect(bare.text).not.toContain("standing orders");
			} finally {
				delete process.env.GOBLIN_HOME;
			}
		});
	});
});

describe("workspace file injection", () => {
	test("USER.md becomes its own section and source", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			writeFileSync(paths.soul(), "You are goblin.");
			writeFileSync(paths.agents(), "notes");
			writeFileSync(paths.user(), "- Prefer terse answers.");
			const { text, sources } = buildSystemPrompt(conv, tools);
			expect(text).toContain("## USER.md — your model of the operator");
			expect(text).toContain("- Prefer terse answers.");
			expect(sources).toContain("USER.md");
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});

	test("no USER.md — no section, no source", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			writeFileSync(paths.soul(), "You are goblin.");
			const { text, sources } = buildSystemPrompt(conv, tools);
			expect(text).not.toContain("## USER.md");
			expect(sources).not.toContain("USER.md");
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});

	test("an oversized file truncates with an in-prompt notice and a warn", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		const logFile = join(home, "goblin.log");
		setLogFile(logFile);
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			writeFileSync(paths.soul(), `You are goblin. ${"x".repeat(9_000)}`);
			const { text } = buildSystemPrompt(conv, tools);
			expect(text).toContain("SOUL.md truncated at 8000 chars");
			// And the log explains it — no REPL needed.
			const warned = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>)
				.some((l) => l.msg === "prompt file truncated");
			expect(warned).toBe(true);
		} finally {
			setLogFile(null);
			delete process.env.GOBLIN_HOME;
		}
	});

	test("the shell carries the memory model, verify, and act-vs-ask rules", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			const { text } = buildSystemPrompt(conv, tools);
			expect(text).toContain("these files are your only");
			expect(text).toContain("Verify before saying done");
			expect(text).toContain("ask first before");
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});
});
