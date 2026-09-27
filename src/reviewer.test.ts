import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel, ToolSet } from "ai";
import { openStore, type ConversationStore } from "./conversation.ts";
import { JevError } from "./jev.ts";
import { setLogFile } from "./log.ts";
import { buildGateState, confineTools, considerTurn, reviewTools, type CompletedTurn, type ReviewerDeps } from "./reviewer.ts";

let dirs: string[] = [];
function tmpdir_(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	setLogFile(null);
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

// Fake skills-ref: records its argv + cwd, exits the planted code.
function fakeSkillsRef(dir: string, code: number): string {
	const bin = join(dir, "skills-ref");
	writeFileSync(bin, `#!/bin/sh\necho "$PWD $@" >> "$(dirname "$0")/calls"\nexit ${code}\n`);
	chmodSync(bin, 0o755);
	return bin;
}
function skillsRefCalls(dir: string): string[] {
	try {
		return readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter((l) => l !== "");
	} catch {
		return [];
	}
}

// Fake the review model at the edge: scripted doGenerate steps — tool
// calls, then text. generateText drives it like any provider. The
// optional hook runs before each step (tests park a review mid-flight).
function fakeReviewModel(
	script: { text?: string; calls?: { name: string; input: unknown }[]; error?: string }[],
	beforeStep?: () => Promise<void>,
): LanguageModel {
	let step = 0;
	let call = 0;
	return {
		specificationVersion: "v2",
		provider: "fake",
		modelId: "fake-review",
		supportedUrls: {},
		doGenerate: async () => {
			if (beforeStep !== undefined) await beforeStep();
			const s = script[Math.min(step++, script.length - 1)]!;
			if (s.error !== undefined) throw new Error(s.error);
			const content: unknown[] = [];
			if (s.text !== undefined) content.push({ type: "text", text: s.text });
			for (const c of s.calls ?? []) {
				content.push({
					type: "tool-call",
					toolCallId: `call-${++call}`,
					toolName: c.name,
					input: JSON.stringify(c.input),
				});
			}
			return {
				content,
				finishReason: (s.calls?.length ?? 0) > 0 ? "tool-calls" : "stop",
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				warnings: [],
			};
		},
		doStream: () => {
			throw new Error("unimplemented");
		},
	} as unknown as LanguageModel;
}

const SKILL_MD = (name: string, extra = "") =>
	`---\nname: ${name}\ndescription: test skill\n---\n\n# ${name}\n${extra}\n`;

interface Harness {
	store: ConversationStore;
	convId: string;
	workspace: string;
	skills: string;
	notified: { conversationId: string; skills: string[] }[];
	depsFor(o: {
		nouls?: { correction: number; procedure: number } | JevError | Error;
		script?: { text?: string; calls?: { name: string; input: unknown }[]; error?: string }[];
		validateCode?: number;
	}): ReviewerDeps;
}

function harness(): Harness {
	const root = tmpdir_();
	const workspace = join(root, "ws");
	const skills = join(workspace, "skills");
	mkdirSync(skills, { recursive: true });
	const store = openStore(join(root, "goblin.sqlite"));
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const notified: Harness["notified"] = [];
	const binDir = join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	return {
		store,
		convId: conv.id,
		workspace,
		skills,
		notified,
		depsFor(o) {
			const gate = {
				decide: async () => {
					const n = o.nouls ?? { correction: 0, procedure: 0 };
					if (n instanceof Error) throw n;
					return { answers: { ...n }, inputTokens: 100, cost: 0.00001 };
				},
			};
			return {
				gate,
				threshold: 0.8,
				reviewModel: async () => ({
					ref: "fake/review",
					model: fakeReviewModel(o.script ?? [{ text: "nothing to do" }]),
				}),
				store,
				skillsDir: skills,
				workspaceDir: workspace,
				notify: async (conversationId, skills) => {
					notified.push({ conversationId, skills });
				},
				skillsRefBin: fakeSkillsRef(binDir, o.validateCode ?? 0),
			};
		},
	};
}

const turn = (over: Partial<CompletedTurn> = {}): CompletedTurn => ({
	conversationId: "dm:1",
	operatorTexts: ["do the thing"],
	replyText: "did the thing",
	toolNames: ["bash"],
	...over,
});

describe("reviewer gate", () => {
	test("below threshold on both questions — no review, model never resolved", async () => {
		const h = harness();
		const deps = h.depsFor({ nouls: { correction: 0.1, procedure: 0.2 } });
		deps.reviewModel = async () => {
			throw new Error("must not resolve a model when the gate says no");
		};
		await considerTurn(deps, turn());
		expect(h.notified).toEqual([]);
		expect(h.store.history(h.convId)).toHaveLength(0);
		h.store.close();
	});

	test("either question at threshold reviews", async () => {
		for (const nouls of [
			{ correction: 0.8, procedure: 0.0 },
			{ correction: 0.0, procedure: 0.95 },
		]) {
			const h = harness();
			let resolved = false;
			const deps = h.depsFor({ nouls, script: [{ text: "nothing worth saving" }] });
			const inner = deps.reviewModel;
			deps.reviewModel = async (conv) => {
				resolved = true;
				return inner(conv);
			};
			await considerTurn(deps, turn());
			expect(resolved).toBe(true);
			h.store.close();
		}
	});

	test("gate failure falls back to the tool-count rule", async () => {
		const quiet = harness();
		await considerTurn(
			quiet.depsFor({ nouls: new JevError("timeout"), script: [{ text: "x" }] }),
			turn({ toolNames: ["bash"] }),
		);
		expect(quiet.notified).toEqual([]);
		quiet.store.close();
		const busy = harness();
		const deps = busy.depsFor({ nouls: new JevError("http", 500), script: [{ text: "nothing" }] });
		let resolved = false;
		const inner = deps.reviewModel;
		deps.reviewModel = async (conv) => {
			resolved = true;
			return inner(conv);
		};
		await considerTurn(deps, turn({ toolNames: new Array(8).fill("bash") }));
		expect(resolved).toBe(true);
		busy.store.close();
	});

	test("a non-gate error propagates — bugs stay loud, never fall back", async () => {
		const h = harness();
		await expect(considerTurn(h.depsFor({ nouls: new Error("boom") }), turn())).rejects.toThrow("boom");
		h.store.close();
	});
});

describe("review run", () => {
	test("a saved skill validates, lands in history, and notifies", async () => {
		const h = harness();
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0.1 },
			script: [
				{
					calls: [{
						name: "write_file",
						input: { path: "pdf-tables/SKILL.md", content: SKILL_MD("pdf-tables") },
					}],
				},
				{ text: "saved" },
			],
		});
		await considerTurn(deps, turn());
		expect(readFileSync(join(h.skills, "pdf-tables", "SKILL.md"), "utf8")).toContain("name: pdf-tables");
		// Validated from the workspace, one skill, then told.
		const binDir = join(deps.workspaceDir, "..", "bin");
		expect(skillsRefCalls(binDir)).toEqual([`${h.workspace} validate ./skills/pdf-tables`]);
		const history = h.store.history(h.convId);
		expect(history).toHaveLength(1);
		expect(history[0]!.role).toBe("system");
		expect((history[0]!.parts[0] as { text: string }).text).toContain("pdf-tables");
		expect(h.notified).toEqual([{ conversationId: h.convId, skills: ["pdf-tables"] }]);
		h.store.close();
	});

	test("no tool calls means no save, no note, no history", async () => {
		const h = harness();
		await considerTurn(
			h.depsFor({ nouls: { correction: 0.0, procedure: 0.99 }, script: [{ text: "nothing worth saving" }] }),
			turn(),
		);
		expect(h.notified).toEqual([]);
		expect(h.store.history(h.convId)).toHaveLength(0);
		h.store.close();
	});

	test("a failed validation reverts every byte — created and edited", async () => {
		const h = harness();
		mkdirSync(join(h.skills, "existing"), { recursive: true });
		writeFileSync(join(h.skills, "existing", "SKILL.md"), SKILL_MD("existing", "original"));
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0.9 },
			validateCode: 1,
			script: [
				{
					calls: [
						{ name: "write_file", input: { path: "fresh/SKILL.md", content: SKILL_MD("fresh") } },
						{
							name: "edit_file",
							input: { path: "existing/SKILL.md", old_string: "original", new_string: "ruined" },
						},
					],
				},
				{ text: "saved" },
			],
		});
		await considerTurn(deps, turn());
		// Created dir gone, edited file byte-identical, nobody told.
		expect(() => readFileSync(join(h.skills, "fresh", "SKILL.md"))).toThrow();
		expect(readFileSync(join(h.skills, "existing", "SKILL.md"), "utf8")).toBe(SKILL_MD("existing", "original"));
		expect(h.notified).toEqual([]);
		expect(h.store.history(h.convId)).toHaveLength(0);
		h.store.close();
	});

	test("a model failure after writes reverts the tree, logs, and appends no history", async () => {
		const h = harness();
		mkdirSync(join(h.skills, "existing"), { recursive: true });
		writeFileSync(join(h.skills, "existing", "SKILL.md"), SKILL_MD("existing", "original"));
		const logFile = join(h.workspace, "goblin.log");
		setLogFile(logFile);
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0.9 },
			script: [
				{
					calls: [{ name: "write_file", input: { path: "partial/SKILL.md", content: SKILL_MD("partial") } }],
				},
				{ error: "provider exploded mid-review" },
			],
		});
		await considerTurn(deps, turn());
		// The tool-write step landed, then the model call died — the tree
		// is back to the snapshot: created dir gone, edited bytes intact.
		expect(() => readFileSync(join(h.skills, "partial", "SKILL.md"))).toThrow();
		expect(readFileSync(join(h.skills, "existing", "SKILL.md"), "utf8")).toBe(SKILL_MD("existing", "original"));
		expect(h.notified).toEqual([]);
		expect(h.store.history(h.convId)).toHaveLength(0);
		const lines = readFileSync(logFile, "utf8").trim().split("\n");
		const reverted = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
			.find((e) => e.msg === "reviewer write reverted — model call failed");
		expect(reverted).toMatchObject({ conversation: "dm:1" });
		expect(String(reverted?.error)).toContain("provider exploded mid-review");
		h.store.close();
	});

	test("a concurrent edit outside the write set survives a failed-validation revert", async () => {
		const h = harness();
		mkdirSync(join(h.skills, "other"), { recursive: true });
		writeFileSync(join(h.skills, "other", "SKILL.md"), SKILL_MD("other", "original"));
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0.9 },
			validateCode: 1,
		});
		let step = 0;
		deps.reviewModel = async () => ({
			ref: "fake/review",
			model: fakeReviewModel(
				[
					{ calls: [{ name: "write_file", input: { path: "bad/SKILL.md", content: SKILL_MD("bad") } }] },
					{ text: "saved" },
				],
				async () => {
					// Step 2's doGenerate runs after the write tool executed —
					// exactly when a concurrent edit (an operator's undo, a
					// hand edit) can land mid-review.
					if (++step === 2) {
						writeFileSync(join(h.skills, "other", "SKILL.md"), SKILL_MD("other", "concurrent"));
					}
				},
			),
		});
		await considerTurn(deps, turn());
		// The review's own write is rolled back; the concurrent edit to a
		// path it never wrote stands.
		expect(() => readFileSync(join(h.skills, "bad", "SKILL.md"))).toThrow();
		expect(readFileSync(join(h.skills, "other", "SKILL.md"), "utf8")).toBe(SKILL_MD("other", "concurrent"));
		expect(h.notified).toEqual([]);
		expect(h.store.history(h.convId)).toHaveLength(0);
		h.store.close();
	});

	test("a concurrent edit survives a model-failure revert too", async () => {
		const h = harness();
		mkdirSync(join(h.skills, "existing"), { recursive: true });
		writeFileSync(join(h.skills, "existing", "SKILL.md"), SKILL_MD("existing", "original"));
		const deps = h.depsFor({ nouls: { correction: 0.9, procedure: 0.9 } });
		let step = 0;
		deps.reviewModel = async () => ({
			ref: "fake/review",
			model: fakeReviewModel(
				[
					{ calls: [{ name: "write_file", input: { path: "partial/SKILL.md", content: SKILL_MD("partial") } }] },
					{ error: "provider exploded mid-review" },
				],
				async () => {
					if (++step === 2) {
						writeFileSync(join(h.skills, "existing", "SKILL.md"), SKILL_MD("existing", "concurrent"));
					}
				},
			),
		});
		await considerTurn(deps, turn());
		expect(() => readFileSync(join(h.skills, "partial", "SKILL.md"))).toThrow();
		expect(readFileSync(join(h.skills, "existing", "SKILL.md"), "utf8")).toBe(SKILL_MD("existing", "concurrent"));
		expect(h.notified).toEqual([]);
		h.store.close();
	});

	test("a concurrent skill appearing mid-review is neither validated nor announced", async () => {
		const h = harness();
		const deps = h.depsFor({ nouls: { correction: 0.9, procedure: 0.1 } });
		deps.reviewModel = async () => ({
			ref: "fake/review",
			model: fakeReviewModel([{ text: "nothing worth saving" }], async () => {
				// Lands after the snapshot walk, while the (idle) review is
				// in flight — a tree-wide diff would blame it on the review.
				mkdirSync(join(h.skills, "unrelated"), { recursive: true });
				writeFileSync(join(h.skills, "unrelated", "SKILL.md"), SKILL_MD("unrelated"));
			}),
		});
		await considerTurn(deps, turn());
		expect(readFileSync(join(h.skills, "unrelated", "SKILL.md"), "utf8")).toContain("name: unrelated");
		const binDir = join(deps.workspaceDir, "..", "bin");
		expect(skillsRefCalls(binDir)).toEqual([]);
		expect(h.notified).toEqual([]);
		expect(h.store.history(h.convId)).toHaveLength(0);
		h.store.close();
	});

	test("a byte-identical rewrite is a no-op — no validation, no announce", async () => {
		const h = harness();
		mkdirSync(join(h.skills, "same"), { recursive: true });
		writeFileSync(join(h.skills, "same", "SKILL.md"), SKILL_MD("same"));
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0.1 },
			script: [
				{ calls: [{ name: "write_file", input: { path: "same/SKILL.md", content: SKILL_MD("same") } }] },
				{ text: "saved" },
			],
		});
		await considerTurn(deps, turn());
		const binDir = join(deps.workspaceDir, "..", "bin");
		expect(skillsRefCalls(binDir)).toEqual([]);
		expect(h.notified).toEqual([]);
		expect(h.store.history(h.convId)).toHaveLength(0);
		h.store.close();
	});

	test("concurrent reviews never overlap — the second starts only after the first finished", async () => {
		const h = harness();
		const events: string[] = [];
		// Review 1's model parks inside its first generate until released;
		// an unserialized second review would start meanwhile.
		let parked = false;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const hanging = fakeReviewModel(
			[
				{ calls: [{ name: "write_file", input: { path: "a/SKILL.md", content: SKILL_MD("a") } }] },
				{ text: "saved" },
			],
			async () => {
				if (!parked) {
					parked = true;
					await gate;
				}
			},
		);
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0.9 },
			script: [{ text: "nothing worth saving" }],
		});
		const inner = deps.reviewModel;
		let resolves = 0;
		deps.reviewModel = async (conv) => {
			resolves += 1;
			events.push(`review ${resolves} started`);
			return resolves === 1 ? { ref: "fake/hang", model: hanging } : inner(conv);
		};
		const p1 = considerTurn(deps, turn());
		const p2 = considerTurn(deps, turn());
		for (let i = 0; i < 500 && !parked; i++) await Bun.sleep(1);
		expect(parked).toBe(true);
		// While review 1 hangs mid-flight, review 2 has not entered.
		await Bun.sleep(20);
		expect(events).toEqual(["review 1 started"]);
		release();
		await p1;
		await p2;
		// Review 2 ran after review 1 finished — its skill saved, told, history.
		expect(events).toEqual(["review 1 started", "review 2 started"]);
		expect(readFileSync(join(h.skills, "a", "SKILL.md"), "utf8")).toContain("name: a");
		expect(h.notified).toEqual([{ conversationId: h.convId, skills: ["a"] }]);
		h.store.close();
	});

	test("a failed review doesn't poison the chain — the next one still runs", async () => {
		const h = harness();
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0.9 },
			script: [{ text: "nothing worth saving" }],
		});
		const inner = deps.reviewModel;
		let resolves = 0;
		deps.reviewModel = async (conv) => {
			resolves += 1;
			if (resolves === 1) throw new Error("model resolve failed");
			return inner(conv);
		};
		// The bug propagates to the runtime's backstop — loud, as designed.
		await expect(considerTurn(deps, turn())).rejects.toThrow("model resolve failed");
		await considerTurn(deps, turn());
		expect(resolves).toBe(2);
		h.store.close();
	});
});

describe("reviewer confinement", () => {
	test("absolute and parent-relative paths refuse; inside paths pass", async () => {
		const h = harness();
		const tools = reviewTools(h.skills);
		const write = tools.write_file as unknown as { execute: (i: unknown) => Promise<unknown> };
		expect(await write.execute({ path: join(h.workspace, "..", "evil.txt"), content: "x" })).toEqual({
			error: expect.stringContaining("escapes the skills directory"),
		});
		expect(await write.execute({ path: "../evil.txt", content: "x" })).toEqual({
			error: expect.stringContaining("escapes the skills directory"),
		});
		expect(await write.execute({ path: "ok/SKILL.md", content: SKILL_MD("ok") })).toEqual({
			path: join(h.skills, "ok", "SKILL.md"),
			bytes: expect.any(Number),
		});
		h.store.close();
	});

	test("an escaping review writes nothing and saves nothing", async () => {
		const h = harness();
		const outside = join(h.workspace, "..", "escaped.txt");
		await considerTurn(
			h.depsFor({
				nouls: { correction: 0.9, procedure: 0.1 },
				script: [{ calls: [{ name: "write_file", input: { path: outside, content: "nope" } }] }, { text: "done" }],
			}),
			turn(),
		);
		expect(() => readFileSync(outside)).toThrow();
		expect(h.notified).toEqual([]);
		expect(h.store.history(h.convId)).toHaveLength(0);
		h.store.close();
	});

	test("confineTools leaves tool-less entries alone", () => {
		const tools = confineTools({ plain: { description: "no execute" } } as unknown as ToolSet, "/root");
		expect(tools as unknown).toEqual({ plain: { description: "no execute" } });
	});
});

describe("buildGateState", () => {
	test("bounded, tail-first operator text, counted tools", () => {
		const state = buildGateState(turn({
			operatorTexts: [`HEADMARKER ${"old ".repeat(5000)}CORRECTION`, "latest"],
			replyText: `HEAD${"x".repeat(20_000)}TAILMARKER`,
			toolNames: ["bash", "read_file", "bash", "bash"],
		}));
		expect(state.length).toBeLessThan(24_000);
		expect(state).toContain("CORRECTION");
		expect(state).toContain("latest");
		expect(state).not.toContain("HEADMARKER");
		expect(state).toContain("HEAD");
		expect(state).not.toContain("TAILMARKER");
		expect(state).toContain("tools: bash ×3, read_file (4 total)");
	});

	test("empty turns still shape a state", () => {
		const state = buildGateState(turn({ operatorTexts: [], replyText: "", toolNames: [] }));
		expect(state).toContain("tools: (none) (0 total)");
	});
});
