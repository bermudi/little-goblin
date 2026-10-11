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
import { openStore, type Conversation } from "../conversation.ts";
import { _resetPromptSourcesForTest, buildSystemPrompt, systemPromptFor } from "./prompt.ts";

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
	projectId: null,
	persona: "personal",
	archivedAt: null,
	pinnedAt: null,
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

	test("the channel line names the conversation's own door", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			const tg = buildSystemPrompt(conv, tools);
			expect(tg.text).toContain("via Telegram (dm-1)");
			expect(tg.text).toContain("Telegram is the UI");
			const app = buildSystemPrompt(
				{ ...conv, id: "app/chat-01", chatId: 0, threadId: null },
				tools,
			);
			expect(app.text).toContain("via the goblin app (app/chat-01)");
			expect(app.text).toContain("The goblin app is the UI");
			expect(app.text).not.toContain("Telegram is the UI");
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

	test("an oversized file keeps head and tail, warns, and names the drop", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		const logFile = join(home, "goblin.log");
		setLogFile(logFile);
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			// Appends land at the end of these files — the sentinel is the
			// newest standing note, and it must survive the cut.
			writeFileSync(
				paths.soul(),
				`You are goblin. ${"x".repeat(25_000)}\nFINAL-STANDING-RULE: never drop the tail`,
			);
			const { text } = buildSystemPrompt(conv, tools);
			expect(text).toContain("SOUL.md truncated at 20000 chars");
			expect(text).toContain("dropped");
			// The tail — the newest notes — survives the truncation.
			expect(text).toContain("FINAL-STANDING-RULE: never drop the tail");
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

	test("a file past the read bound still yields its real tail", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		const logFile = join(home, "goblin.log");
		setLogFile(logFile);
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			// ~100KB > the ~60KB bounded read: the head window's own end
			// must not be passed off as the file's tail.
			writeFileSync(
				paths.soul(),
				`You are goblin. ${"x".repeat(59_500)}WINDOW-END-MARKER${"y".repeat(40_000)}\nFINAL-STANDING-RULE`,
			);
			const { text } = buildSystemPrompt(conv, tools);
			// The file's true end — the newest notes — survives.
			expect(text).toContain("FINAL-STANDING-RULE");
			// The head window's tail (last ~430 bytes of the read) does not.
			expect(text).not.toContain("WINDOW-END-MARKER");
			// The dropped middle is bytes, marked an estimate — the char
			// count is unknowable without decoding the whole file.
			expect(text).toMatch(/dropped ~\d+ bytes from the middle/);
			const warned = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>)
				.some((l) => l.msg === "prompt file truncated" && typeof l.droppedBytes === "number");
			expect(warned).toBe(true);
		} finally {
			setLogFile(null);
			delete process.env.GOBLIN_HOME;
		}
	});

	test("USER.md is capped tighter — a profile stays directive-sized", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			writeFileSync(paths.soul(), "You are goblin.");
			writeFileSync(
				paths.user(),
				`- terse operator ${"y".repeat(6_000)}\n- prefers plain language`,
			);
			const { text } = buildSystemPrompt(conv, tools);
			expect(text).toContain("USER.md truncated at 4000 chars");
			// Openclaw's rule: profile guidance must not balloon into
			// per-turn dead weight — 4k, and the newest lines survive.
			expect(text).toContain("- prefers plain language");
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});

	test("systemPromptFor freezes per conversation — edits load only at boundaries", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		const store = openStore(join(home, "goblin.sqlite"));
		// A real conversation row — the snapshot references it.
		const live = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			writeFileSync(paths.soul(), "You are goblin, v1.");
			const frozen = systemPromptFor(store, live, tools);
			// A mid-conversation edit — by the operator or the agent itself.
			writeFileSync(paths.soul(), "You are goblin, v2.");
			// The live conversation keeps its frozen bytes: its prefix
			// cache is never rewritten underneath it.
			expect(systemPromptFor(store, live, tools).text).toBe(frozen.text);
			// A boundary (compaction clears; a roll mints a new id) —
			// the next build picks the edit up.
			store.clearPromptSnapshot(live.id);
			expect(systemPromptFor(store, live, tools).text).toContain("You are goblin, v2.");
			// And freezes again from there.
			writeFileSync(paths.soul(), "You are goblin, v3.");
			expect(systemPromptFor(store, live, tools).text).not.toContain("You are goblin, v3.");
		} finally {
			store.close();
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
	// The sandbox boundary (design/telegram.md → Guest mode): a guest
	// persona build touches no operator file — SOUL, USER, skills, none
	// of it — and says so in its own words.
	test("a guest persona prompt reads nothing private", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			const guest = { ...conv, id: "guest:-100:9", persona: "guest" as const };
			const { text, sources } = buildSystemPrompt(guest, ["search", "fetch"]);
			expect(sources).toEqual(["guest persona"]);
			expect(text).toContain("third-party chat");
			expect(text).toContain("Do not discuss the bot's operator");
			expect(text).not.toContain("SOUL.md");
			expect(text).not.toContain("USER.md");
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});
	// The operator's own guest summons keep the personal persona but
	// must know the room has readers (design/telegram.md → Guest mode).
	test("a personal guest-channel prompt says who can read it", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			const guestChannel = { ...conv, id: "guest:-100:7" };
			const { text } = buildSystemPrompt(guestChannel, tools);
			expect(text).toContain("guest in a third-party chat");
			expect(text).toContain("Other people can read this chat");
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});
});

// Project prompts (design/projects.md): a bound conversation gets its
// project's own environment — dir, instructions, absolute identity and
// skill paths, and a linked dir's AGENTS.md. The unbound build is
// untouched above.
describe("project prompts", () => {
	const project = (dir: string, over: Partial<import("../projects.ts").Project> = {}) => ({
		id: "proj-1",
		name: "Side Project",
		slug: "side-project",
		home: dir,
		dir,
		managed: true,
		instructions: "",
		memory: "shared" as const,
		createdAt: "2026-01-01T00:00:00Z",
		archivedAt: null,
		...over,
	});

	test("a managed project names its dir, carries instructions, and goes absolute", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			// A real catalog entry — the relative path must not survive a
			// project cwd.
			const skillDir = join(paths.skills(), "mq");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				"---\nname: mq\ndescription: jq for Markdown\n---\nbody\n",
			);
			const dir = join(home, "projects", "side-project");
			const p = project(dir, { instructions: "Keep answers in metric." });
			const { text, sources } = buildSystemPrompt(
				{ ...conv, id: "app/chat-9", chatId: 0, projectId: p.id },
				tools,
				p,
			);
			expect(text).toContain(`Working directory: ${dir}`);
			expect(text).toContain("this project's directory");
			expect(text).toContain(`## project — Side Project`);
			expect(text).toContain("Keep answers in metric.");
			// Identity files anchor at the workspace absolutely — a
			// relative edit from the project cwd would land in the project.
			expect(text).toContain(`in ${paths.workspace()} are your`);
			// The catalog renders absolute paths.
			expect(text).toContain(`(${join(paths.workspace(), "skills", "mq", "SKILL.md")})`);
			expect(text).not.toContain("(skills/mq/SKILL.md)");
			// Managed homes never carry an AGENTS.md subsection.
			expect(text).not.toContain("### AGENTS.md in");
			expect(sources).toContain("project");
			expect(sources).not.toContain("project-AGENTS.md");
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});

	test("a linked dir contributes its own AGENTS.md", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			const dir = join(home, "elsewhere", "repo");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "AGENTS.md"), "run bun test, not npm");
			const p = project(dir, { managed: false });
			const { text, sources } = buildSystemPrompt(
				{ ...conv, id: "app/chat-9", chatId: 0, projectId: p.id },
				tools,
				p,
			);
			expect(text).toContain(`### AGENTS.md in ${dir}`);
			expect(text).toContain("run bun test, not npm");
			expect(sources).toContain("project");
			expect(sources).toContain("project-AGENTS.md");

			// No file, no subsection, no source.
			const bare = project(join(home, "elsewhere", "empty"), { managed: false });
			mkdirSync(bare.dir, { recursive: true });
			const second = buildSystemPrompt(
				{ ...conv, id: "app/chat-9", chatId: 0, projectId: bare.id },
				tools,
				bare,
			);
			expect(second.text).not.toContain("### AGENTS.md in");
			expect(second.sources).not.toContain("project-AGENTS.md");
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});

	test("an empty-instructions project still names itself; no project is byte-identical", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			const p = project(join(home, "projects", "side-project"));
			const { text } = buildSystemPrompt(
				{ ...conv, id: "app/chat-9", chatId: 0, projectId: p.id },
				tools,
				p,
			);
			expect(text).toContain("## project — Side Project");
			// The unbound build at the same address: identical bytes to a
			// build that never heard of projects.
			const unbound = buildSystemPrompt({ ...conv, id: "app/chat-9", chatId: 0 }, tools);
			const plain = buildSystemPrompt({ ...conv, id: "app/chat-9", chatId: 0 }, tools, null);
			expect(unbound.text).toBe(plain.text);
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});

	test("the notes index renders under the project section — pointers, not bodies", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			const p = project(join(home, "projects", "side-project"));
			const c = { ...conv, id: "app/chat-9", chatId: 0, projectId: p.id };
			const { text, sources } = buildSystemPrompt(c, tools, p, [
				{ id: "n-1", title: "reading list" },
				{ id: "n-2", title: "ideas" },
			]);
			expect(text).toContain("### notes");
			expect(text).toContain("- reading list (id n-1)");
			expect(text).toContain("- ideas (id n-2)");
			expect(sources).toContain("notes-index");
			// An empty index omits the subsection and the source.
			const empty = buildSystemPrompt(c, tools, p, []);
			expect(empty.text).not.toContain("### notes");
			expect(empty.sources).not.toContain("notes-index");
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});
});

describe("the app fence convention", () => {
	test("the bullet rides the note tool on app — nowhere else", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			const appConv = { ...conv, id: "app/chat-9", chatId: 0 };
			const withNote = buildSystemPrompt(appConv, [...tools, "note"]);
			expect(withNote.text).toContain('note title="…"');
			expect(withNote.text).toContain("append-to-note");
			// No tool, no bullet — Telegram carries it nowhere either
			// (the fenced card is an app-UI affordance only).
			const noTool = buildSystemPrompt(appConv, tools);
			expect(noTool.text).not.toContain("append-to-note");
			const tg = buildSystemPrompt(conv, [...tools, "note"]);
			expect(tg.text).not.toContain("append-to-note");
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});
});
