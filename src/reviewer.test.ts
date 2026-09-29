import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel, ToolSet } from "ai";
import { openStore, type ConversationStore } from "./conversation.ts";
import { JevError } from "./jev.ts";
import { setLogFile } from "./log.ts";
import {
	buildGateState,
	cancelReviews,
	confineTools,
	considerTurn,
	resetReviewerState,
	reviewTools,
	stagingRoot,
	summarize,
	toolOk,
	type CompletedTurn,
	type EvidenceLimits,
	type PriorTurnContext,
	type ReviewerDeps,
	type ToolCallDigest,
} from "./reviewer.ts";

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
	resetReviewerState();
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
// optional hook runs before each step (tests park a review mid-flight);
// `prompts`, when passed, records every serialized prompt for payload
// assertions.
function fakeReviewModel(
	script: { text?: string; calls?: { name: string; input: unknown }[]; error?: string }[],
	beforeStep?: () => Promise<void>,
	prompts?: string[],
): LanguageModel {
	let step = 0;
	let call = 0;
	return {
		specificationVersion: "v4",
		provider: "fake",
		modelId: "fake-review",
		supportedUrls: {},
		doGenerate: async (options: unknown) => {
			if ((options as { abortSignal?: AbortSignal }).abortSignal?.aborted) {
				throw new Error("aborted before provider call");
			}
			if (beforeStep !== undefined) await beforeStep();
			if (prompts !== undefined) {
				prompts.push(JSON.stringify((options as { prompt?: unknown }).prompt ?? null));
			}
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
				finishReason:
					(s.calls?.length ?? 0) > 0
						? { unified: "tool-calls", raw: undefined }
						: { unified: "stop", raw: undefined },
				usage: { inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: undefined, reasoning: undefined } },
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

const EVIDENCE: EvidenceLimits = { calls: 8, argChars: 300, outChars: 300 };

interface Harness {
	store: ConversationStore;
	convId: string;
	workspace: string;
	skills: string;
	staging: string;
	notified: { conversationId: string; skills: string[] }[];
	depsFor(o: {
		nouls?: { correction: number; procedure: number } | JevError | Error;
		script?: { text?: string; calls?: { name: string; input: unknown }[]; error?: string }[];
		validateCode?: number;
		queueCap?: number;
		evidence?: EvidenceLimits;
		thresholds?: { correction: number; procedure: number };
		prompts?: string[];
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
		staging: stagingRoot(workspace),
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
				thresholds: o.thresholds ?? { correction: 0.8, procedure: 0.8 },
				queueCap: o.queueCap ?? 3,
				evidence: o.evidence ?? EVIDENCE,
				reviewModel: async () => ({
					ref: "fake/review",
					model: fakeReviewModel(o.script ?? [{ text: "nothing to do" }], undefined, o.prompts),
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

const digestEntry = (over: Partial<ToolCallDigest> = {}): ToolCallDigest => ({
	tool: "bash",
	args: '{"cmd":"ls"}',
	result: "ok",
	ok: true,
	...over,
});

const turn = (over: Partial<CompletedTurn> = {}): CompletedTurn => ({
	conversationId: "dm:1",
	turnSeq: 1,
	operatorTexts: ["do the thing"],
	replyText: "did the thing",
	toolNames: ["bash"],
	toolDigest: [digestEntry()],
	...over,
});

const prior = (over: Partial<PriorTurnContext> = {}): PriorTurnContext => ({
	operatorTexts: ["sort the pdfs"],
	replyText: "sorted them wrongly",
	toolDigest: [digestEntry({ tool: "read_file", result: "file not found", ok: false })],
	...over,
});

// The fake model records its serialized prompt (a provider-format
// message array); pull the text back out for substring assertions.
function promptText(recorded: string): string {
	const parsed = JSON.parse(recorded) as unknown;
	if (!Array.isArray(parsed)) return String(parsed);
	return parsed
		.map((m) => {
			const content = (m as { content?: unknown }).content;
			return Array.isArray(content)
				? content.map((c) => (typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n")
				: "";
		})
		.join("\n");
}

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

	test("per-question thresholds are independent", async () => {
		const h = harness();
		const deps = h.depsFor({
			nouls: { correction: 0.85, procedure: 0.4 },
			thresholds: { correction: 0.9, procedure: 0.5 },
		});
		deps.reviewModel = async () => {
			throw new Error("correction below its own threshold — must not review");
		};
		await considerTurn(deps, turn());
		const h2 = harness();
		const deps2 = h2.depsFor({
			nouls: { correction: 0.0, procedure: 0.6 },
			thresholds: { correction: 0.9, procedure: 0.5 },
			script: [{ text: "nothing worth saving" }],
		});
		let resolved = false;
		const inner = deps2.reviewModel;
		deps2.reviewModel = async (conv) => {
			resolved = true;
			return inner(conv);
		};
		await considerTurn(deps2, turn());
		expect(resolved).toBe(true);
		h.store.close();
		h2.store.close();
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

	test("the gate line carries tool names, thresholds, and the fallback streak", async () => {
		const h = harness();
		const logFile = join(h.workspace, "goblin.log");
		setLogFile(logFile);
		const fallback = h.depsFor({ nouls: new JevError("timeout"), script: [{ text: "x" }] });
		await considerTurn(fallback, turn({ toolNames: ["bash", "read_file", "bash"] }));
		await considerTurn(fallback, turn({ toolNames: ["bash"] }));
		const ok = h.depsFor({ nouls: { correction: 0.1, procedure: 0.1 } });
		await considerTurn(ok, turn({ toolNames: ["bash", "send"] }));
		const gates = readFileSync(logFile, "utf8").trim().split("\n")
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((e) => e.msg === "reviewer gate");
		expect(gates).toHaveLength(3);
		expect(gates[0]).toMatchObject({ fallback: true, fallbackStreak: 1, tools: ["bash", "read_file"] });
		expect(gates[1]).toMatchObject({ fallback: true, fallbackStreak: 2 });
		expect(gates[2]).toMatchObject({ fallback: false, fallbackStreak: 0, tools: ["bash", "send"] });
		expect(gates[2]!.thresholds).toEqual({ correction: 0.8, procedure: 0.8 });
		h.store.close();
	});
});

describe("review run — staging and publication", () => {
	test("a saved skill validates against staging, publishes, lands in history, and notifies", async () => {
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
		// Validated from the review's staging copy, one skill, then told.
		const binDir = join(deps.workspaceDir, "..", "bin");
		const calls = skillsRefCalls(binDir);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatch(/validate \.\/skills\/pdf-tables$/);
		expect(calls[0]).toContain(".reviewer-staging");
		// Staging is single-use — cleaned after publish.
		expect(readdirSync(h.staging)).toEqual([]);
		const history = h.store.history(h.convId);
		expect(history).toHaveLength(1);
		expect(history[0]!.role).toBe("system");
		expect((history[0]!.parts[0] as { text: string }).text).toContain("pdf-tables");
		expect(h.notified).toEqual([{ conversationId: h.convId, skills: ["pdf-tables"] }]);
		h.store.close();
	});

	test("publishing an edited skill preserves the executable mode of copied helpers", async () => {
		const h = harness();
		mkdirSync(join(h.skills, "existing"));
		writeFileSync(join(h.skills, "existing", "SKILL.md"), SKILL_MD("existing", "before"));
		const helper = join(h.skills, "existing", "helper.sh");
		writeFileSync(helper, "#!/bin/sh\nexit 0\n");
		chmodSync(helper, 0o755);
		await considerTurn(h.depsFor({
			nouls: { correction: 0.9, procedure: 0 },
			script: [
				{ calls: [{ name: "write_file", input: {
					path: "existing/SKILL.md", content: SKILL_MD("existing", "after"),
				} }] },
				{ text: "saved" },
			],
		}), turn());
		expect(lstatSync(helper).mode & 0o777).toBe(0o755);
		h.store.close();
	});

	test("an earlier published skill is recorded when a later swap fails", async () => {
		const h = harness();
		const logFile = join(h.workspace, "goblin.log");
		setLogFile(logFile);
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0 },
			script: [
				{ calls: [
					{ name: "write_file", input: { path: "a/SKILL.md", content: SKILL_MD("a") } },
					{ name: "write_file", input: { path: "b/SKILL.md", content: SKILL_MD("b") } },
				] },
				{ text: "saved" },
			],
		});
		// Simulate a mechanical failure between validation and the swap:
		// a validates and publishes, but b's staged source goes missing.
		const bin = deps.skillsRefBin!;
		writeFileSync(bin, '#!/bin/sh\nif [ "$2" = "./skills/b" ]; then mv "$PWD/skills/b" "$PWD/skills/moved"; fi\n');
		chmodSync(bin, 0o755);
		await expect(considerTurn(deps, turn())).rejects.toThrow();
		expect(readFileSync(join(h.skills, "a", "SKILL.md"), "utf8")).toContain("name: a");
		expect(existsSync(join(h.skills, "b"))).toBe(false);
		expect(h.store.history(h.convId)).toHaveLength(1);
		expect((h.store.history(h.convId)[0]!.parts[0] as { text: string }).text).toContain("saved skill: a");
		expect(h.notified).toEqual([{ conversationId: h.convId, skills: ["a"] }]);
		expect(readFileSync(logFile, "utf8")).toContain("reviewer publish failed");
		h.store.close();
	});

	test("the live catalog is untouched until the review finishes — writes land only in staging", async () => {
		const h = harness();
		let step = 0;
		let release!: () => void;
		const parked = new Promise<void>((r) => {
			release = r;
		});
		const deps = h.depsFor({ nouls: { correction: 0.9, procedure: 0.9 } });
		deps.reviewModel = async () => ({
			ref: "fake/park",
			model: fakeReviewModel(
				[
					{ calls: [{ name: "write_file", input: { path: "fresh/SKILL.md", content: SKILL_MD("fresh") } }] },
					{ text: "saved" },
			],
				async () => {
					if (++step === 2) await parked;
				},
			),
		});
		const p = considerTurn(deps, turn());
		let stagedFile: string | null = null;
		for (let i = 0; i < 500 && stagedFile === null; i++) {
			await Bun.sleep(1);
			const entries = readdirSync(h.staging);
			if (entries.length > 0) {
				stagedFile = join(h.staging, entries[0]!, "skills", "fresh", "SKILL.md");
			}
		}
		expect(stagedFile).not.toBeNull();
		// The staged write exists; the live catalog has never seen it.
		expect(readFileSync(stagedFile!, "utf8")).toContain("name: fresh");
		expect(() => readFileSync(join(h.skills, "fresh", "SKILL.md"))).toThrow();
		release();
		await p;
		// Published only after the (parked) review completed.
		expect(readFileSync(join(h.skills, "fresh", "SKILL.md"), "utf8")).toContain("name: fresh");
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

	test("a failed validation discards staging — the live catalog never saw a byte", async () => {
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
		expect(() => readFileSync(join(h.skills, "fresh", "SKILL.md"))).toThrow();
		expect(readFileSync(join(h.skills, "existing", "SKILL.md"), "utf8")).toBe(SKILL_MD("existing", "original"));
		expect(readdirSync(h.staging)).toEqual([]);
		expect(h.notified).toEqual([]);
		expect(h.store.history(h.convId)).toHaveLength(0);
		h.store.close();
	});

	test("a model failure after writes discards staging and logs", async () => {
		const h = harness();
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
		expect(() => readFileSync(join(h.skills, "partial", "SKILL.md"))).toThrow();
		expect(readdirSync(h.staging)).toEqual([]);
		expect(h.notified).toEqual([]);
		expect(h.store.history(h.convId)).toHaveLength(0);
		const lines = readFileSync(logFile, "utf8").trim().split("\n");
		const discarded = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
			.find((e) => e.msg === "reviewer write discarded — model call failed");
		expect(discarded).toMatchObject({ conversation: "dm:1" });
		expect(String(discarded?.error)).toContain("provider exploded mid-review");
		h.store.close();
	});

	test("a write over the byte budget is discarded unvalidated", async () => {
		const h = harness();
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0.9 },
			script: [
				{
					calls: [{
						name: "write_file",
						input: { path: "big/SKILL.md", content: `x`.repeat(120 * 1024) },
					}],
				},
				{ text: "saved" },
			],
		});
		await considerTurn(deps, turn());
		expect(() => readFileSync(join(h.skills, "big", "SKILL.md"))).toThrow();
		expect(readdirSync(h.staging)).toEqual([]);
		const binDir = join(deps.workspaceDir, "..", "bin");
		expect(skillsRefCalls(binDir)).toEqual([]);
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

	test("publishing an edited skill swaps whole directories — no mixed-content window", async () => {
		const h = harness();
		mkdirSync(join(h.skills, "editme"), { recursive: true });
		writeFileSync(join(h.skills, "editme", "SKILL.md"), SKILL_MD("editme", "old body"));
		writeFileSync(join(h.skills, "editme", "helper.md"), "old helper");
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0.1 },
			script: [
				{
					calls: [
						{ name: "write_file", input: { path: "editme/SKILL.md", content: SKILL_MD("editme", "new body") } },
						{ name: "write_file", input: { path: "editme/helper.md", content: "new helper" } },
					],
				},
				{ text: "saved" },
			],
		});
		await considerTurn(deps, turn());
		expect(readFileSync(join(h.skills, "editme", "SKILL.md"), "utf8")).toContain("new body");
		expect(readFileSync(join(h.skills, "editme", "helper.md"), "utf8")).toBe("new helper");
		expect(h.notified).toEqual([{ conversationId: h.convId, skills: ["editme"] }]);
		h.store.close();
	});

	test("an operator edit to the same skill mid-review skips the publish, never clobbers", async () => {
		const h = harness();
		mkdirSync(join(h.skills, "clash"), { recursive: true });
		writeFileSync(join(h.skills, "clash", "SKILL.md"), SKILL_MD("clash", "original"));
		const logFile = join(h.workspace, "goblin.log");
		setLogFile(logFile);
		const deps = h.depsFor({ nouls: { correction: 0.9, procedure: 0.1 } });
		let step = 0;
		deps.reviewModel = async () => ({
			ref: "fake/review",
			model: fakeReviewModel(
				[
					{ calls: [{ name: "write_file", input: { path: "clash/SKILL.md", content: SKILL_MD("clash", "review's take") } }] },
					{ text: "saved" },
				],
				async () => {
					// Between the staged write and the publish — exactly when a
					// hand edit can land in the live tree.
					if (++step === 2) {
						writeFileSync(join(h.skills, "clash", "SKILL.md"), SKILL_MD("clash", "operator's edit"));
					}
				},
			),
		});
		await considerTurn(deps, turn());
		expect(readFileSync(join(h.skills, "clash", "SKILL.md"), "utf8")).toContain("operator's edit");
		expect(h.notified).toEqual([]);
		expect(h.store.history(h.convId)).toHaveLength(0);
		const skipped = readFileSync(logFile, "utf8").trim().split("\n")
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.find((e) => e.msg === "reviewer publish skipped — live skills changed mid-review");
		expect(skipped).toMatchObject({ conversation: "dm:1" });
		h.store.close();
	});

	test("a symlinked live skill conflicts at publish — the link and its target survive", async () => {
		const h = harness();
		const logFile = join(h.workspace, "goblin.log");
		setLogFile(logFile);
		// The operator links a skill in from elsewhere (a dots repo, say).
		// The drift check must not resolve it: even matching content
		// through the link would publish over it and fork the source.
		const truth = join(h.workspace, "..", "truth");
		mkdirSync(truth, { recursive: true });
		writeFileSync(join(truth, "SKILL.md"), SKILL_MD("linked", "source of truth"));
		symlinkSync(truth, join(h.skills, "linked"));
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0.1 },
			script: [
				{
					calls: [{
						name: "write_file",
						input: { path: "linked/SKILL.md", content: SKILL_MD("linked", "review's take") },
					}],
				},
				{ text: "saved" },
			],
		});
		await considerTurn(deps, turn());
		// Still a link, still the operator's bytes — nothing forked.
		expect(lstatSync(join(h.skills, "linked")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(h.skills, "linked", "SKILL.md"), "utf8")).toContain("source of truth");
		expect(h.notified).toEqual([]);
		expect(h.store.history(h.convId)).toHaveLength(0);
		const skipped = readFileSync(logFile, "utf8").trim().split("\n")
			.map((l) => JSON.parse(l) as { msg: string; skipped?: { skill: string; drifted: string[] }[] })
			.find((e) => e.msg === "reviewer publish skipped — live skills changed mid-review");
		expect(skipped?.skipped).toEqual([{ skill: "linked", drifted: ["linked"] }]);
		h.store.close();
	});

	test("a symlinked file inside a live skill conflicts at publish, never swaps the dir", async () => {
		const h = harness();
		const notes = join(h.workspace, "..", "notes.md");
		writeFileSync(notes, "operator's notes");
		mkdirSync(join(h.skills, "partly"));
		writeFileSync(join(h.skills, "partly", "SKILL.md"), SKILL_MD("partly", "original"));
		symlinkSync(notes, join(h.skills, "partly", "notes.md"));
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0.1 },
			script: [
				{
					calls: [{
						name: "write_file",
						input: { path: "partly/SKILL.md", content: SKILL_MD("partly", "review's take") },
					}],
				},
				{ text: "saved" },
			],
		});
		await considerTurn(deps, turn());
		// The whole-dir swap is refused: original bytes, link intact.
		expect(readFileSync(join(h.skills, "partly", "SKILL.md"), "utf8")).toContain("original");
		expect(lstatSync(join(h.skills, "partly", "notes.md")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(h.skills, "partly", "notes.md"), "utf8")).toBe("operator's notes");
		expect(h.notified).toEqual([]);
		expect(h.store.history(h.convId)).toHaveLength(0);
		h.store.close();
	});

	test("a skill appearing live mid-review is neither validated nor announced", async () => {
		const h = harness();
		const deps = h.depsFor({ nouls: { correction: 0.9, procedure: 0.1 } });
		deps.reviewModel = async () => ({
			ref: "fake/review",
			model: fakeReviewModel([{ text: "nothing worth saving" }], async () => {
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

	test("a broken symlink in the live tree is logged and skipped, not fatal", async () => {
		const h = harness();
		const logFile = join(h.workspace, "goblin.log");
		setLogFile(logFile);
		symlinkSync(join(h.skills, "missing"), join(h.skills, "broken"));
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0 },
			script: [{ text: "nothing worth saving" }],
		});
		await considerTurn(deps, turn());
		// The review still ran; the dead link is still live — one
		// unresolvable entry doesn't veto the whole review.
		expect(lstatSync(join(h.skills, "broken")).isSymbolicLink()).toBe(true);
		expect(readdirSync(h.staging)).toEqual([]);
		const msgs = readFileSync(logFile, "utf8").trim().split("\n")
			.map((l) => JSON.parse(l) as { msg: string }).map((e) => e.msg);
		expect(msgs).toContain("reviewer staging skipped unresolved skills-tree entry");
		expect(msgs).toContain("reviewer review done");
		expect(msgs).not.toContain("reviewer review skipped — skills tree copy failed");
		h.store.close();
	});

	test("staging refuses external file and directory links but flattens in-root links", async () => {
		const h = harness();
		const logFile = join(h.workspace, "goblin.log");
		setLogFile(logFile);
		const outside = join(h.workspace, "..", "private");
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.md"), "private data");
		symlinkSync(join(outside, "secret.md"), join(h.skills, "external.md"));
		symlinkSync(outside, join(h.skills, "external-dir"));
		writeFileSync(join(h.skills, "safe.md"), "in-root data");
		symlinkSync(join(h.skills, "safe.md"), join(h.skills, "internal.md"));
		const deps = h.depsFor({ nouls: { correction: 0.9, procedure: 0 } });
		const original = deps.reviewModel;
		deps.reviewModel = async (conv) => {
			const staged = join(h.staging, readdirSync(h.staging)[0]!, "skills");
			expect(readdirSync(staged).sort()).toEqual(["internal.md", "safe.md"]);
			expect(readFileSync(join(staged, "internal.md"), "utf8")).toBe("in-root data");
			return original(conv);
		};
		await considerTurn(deps, turn());
		const skipped = readFileSync(logFile, "utf8").trim().split("\n")
			.map((l) => JSON.parse(l) as { msg: string; path?: string })
			.filter((e) => e.msg === "reviewer staging skipped out-of-root skills-tree entry")
			.map((e) => e.path);
		expect(skipped.sort()).toEqual(["external-dir", "external.md"]);
		h.store.close();
	});

	test("an over-budget tree keeps the budget label — policy, not mechanical failure", async () => {
		const h = harness();
		const logFile = join(h.workspace, "goblin.log");
		setLogFile(logFile);
		// 513 files crosses MAX_STAGING_FILES (512) without any of them
		// being unreadable — a policy stop, not a copy failure.
		for (let i = 0; i <= 512; i++) writeFileSync(join(h.skills, `f${i}.txt`), "x");
		const deps = h.depsFor({ nouls: { correction: 0.9, procedure: 0 } });
		await considerTurn(deps, turn());
		expect(readdirSync(h.staging)).toEqual([]);
		const binDir = join(deps.workspaceDir, "..", "bin");
		expect(skillsRefCalls(binDir)).toEqual([]);
		const msgs = readFileSync(logFile, "utf8").trim().split("\n")
			.map((l) => JSON.parse(l) as { msg: string }).map((e) => e.msg);
		expect(msgs).toContain("reviewer review skipped — skills tree over staging budget");
		expect(msgs).not.toContain("reviewer review skipped — skills tree copy failed");
		h.store.close();
	});
});

describe("review queue", () => {
	test("concurrent reviews never overlap — the second starts only after the first finished", async () => {
		const h = harness();
		const events: string[] = [];
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
		const p2 = considerTurn(deps, turn({ turnSeq: 2 }));
		for (let i = 0; i < 500 && !parked; i++) await Bun.sleep(1);
		expect(parked).toBe(true);
		await Bun.sleep(20);
		expect(events).toEqual(["review 1 started"]);
		release();
		await p1;
		await p2;
		expect(events).toEqual(["review 1 started", "review 2 started"]);
		expect(readFileSync(join(h.skills, "a", "SKILL.md"), "utf8")).toContain("name: a");
		expect(h.notified).toEqual([{ conversationId: h.convId, skills: ["a"] }]);
		h.store.close();
	});

	test("a full queue drops the incoming review and logs why", async () => {
		const h = harness();
		const logFile = join(h.workspace, "goblin.log");
		setLogFile(logFile);
		let parked = false;
		let release!: () => void;
		const park = new Promise<void>((r) => {
			release = r;
		});
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0.9 },
			queueCap: 2,
			script: [{ text: "nothing worth saving" }],
		});
		let resolves = 0;
		const inner = deps.reviewModel;
		deps.reviewModel = async (conv) => {
			const n = ++resolves;
			return inner(conv).then((r) => {
				if (n === 1) {
					parked = true;
					return { ref: r.ref, model: fakeReviewModel([{ text: "hang" }], async () => { await park; }) };
				}
				return r;
			});
		};
		// Four firing turns against cap 2: one runs, two queue, one drops.
		const ps = [
			considerTurn(deps, turn({ turnSeq: 1 })),
			considerTurn(deps, turn({ turnSeq: 2 })),
			considerTurn(deps, turn({ turnSeq: 3 })),
			considerTurn(deps, turn({ turnSeq: 4 })),
		];
		for (let i = 0; i < 500 && !parked; i++) await Bun.sleep(1);
		const dropped = readFileSync(logFile, "utf8").trim().split("\n")
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.find((e) => e.msg === "reviewer queue full — review dropped");
		expect(dropped).toMatchObject({ conversation: "dm:1", queued: 2, cap: 2, seq: 4 });
		release();
		await Promise.all(ps);
		expect(resolves).toBe(3); // the dropped turn's model never resolved
		h.store.close();
	});

	test("reviews serialize by turn completion order, not gate-resolution order", async () => {
		const h = harness();
		const prompts: string[] = [];
		let releasePark!: () => void;
		const parked = new Promise<void>((r) => {
			releasePark = r;
		});
		const deps = h.depsFor({ nouls: { correction: 0.9, procedure: 0 }, prompts, script: [{ text: "nothing worth saving" }] });
		// One shared fake: its first doGenerate parks until released, so
		// review 1 runs (parked) while the others queue.
		deps.reviewModel = async () => ({
			ref: "fake/park",
			model: fakeReviewModel([{ text: "done" }], () => parked, prompts),
		});
		const p1 = considerTurn(deps, turn({ turnSeq: 1, operatorTexts: ["ONE"] }));
		await Bun.sleep(30); // review 1 in-flight at its model call
		// seq 5's gate is instant — it enqueues FIRST.
		const p5 = considerTurn(deps, turn({ turnSeq: 5, operatorTexts: ["FIVE"] }));
		await Bun.sleep(30);
		// seq 3's gate is held, then released — it enqueues SECOND,
		// after 5, despite completing earlier.
		let releaseGate!: () => void;
		const gateHold = new Promise<void>((r) => {
			releaseGate = r;
		});
		const p3 = considerTurn(
			{
				...deps,
				gate: {
					decide: async () => {
						await gateHold;
						return { answers: { correction: 0.9, procedure: 0 }, inputTokens: 1, cost: 0 };
					},
				},
			},
			turn({ turnSeq: 3, operatorTexts: ["THREE"] }),
		);
		await Bun.sleep(20);
		releaseGate();
		await Bun.sleep(30); // 3 is queued behind 5 by arrival
		releasePark();
		await Promise.all([p1, p3, p5]);
		// Execution order: ONE (already running), then THREE (earlier
		// completion wins the queue), then FIVE.
		const order = prompts.map((p) => (p.includes("THREE") ? 3 : p.includes("FIVE") ? 5 : 1));
		expect(order).toEqual([1, 3, 5]);
		h.store.close();
	});

	test("a failed review doesn't poison the queue — the next one still runs", async () => {
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
		await expect(considerTurn(deps, turn())).rejects.toThrow("model resolve failed");
		expect(readdirSync(h.staging)).toEqual([]);
		await considerTurn(deps, turn({ turnSeq: 2 }));
		expect(resolves).toBe(2);
		h.store.close();
	});

	// Permission bits can't make a file unreadable for root (uid 0 reads
	// through 0o000). Use an in-root unreadable file: external links are
	// deliberately refused before any read.
	test.skipIf(process.geteuid?.() === 0)(
		"a failed staging copy removes its partial tree and logs the real cause",
		async () => {
		const h = harness();
		const logFile = join(h.workspace, "goblin.log");
		setLogFile(logFile);
		// An unreadable file kills the copy after the staging dir exists —
		// a mechanical failure that must not wear the budget label.
		writeFileSync(join(h.skills, "secret.md"), "unreadable");
		chmodSync(join(h.skills, "secret.md"), 0o000);
		const deps = h.depsFor({ nouls: { correction: 0.9, procedure: 0 } });
		await considerTurn(deps, turn());
		expect(readdirSync(h.staging)).toEqual([]);
		const binDir = join(deps.workspaceDir, "..", "bin");
		expect(skillsRefCalls(binDir)).toEqual([]);
		const msgs = readFileSync(logFile, "utf8").trim().split("\n")
			.map((l) => JSON.parse(l) as { msg: string }).map((e) => e.msg);
		expect(msgs).toContain("reviewer review skipped — skills tree copy failed");
		expect(msgs).not.toContain("reviewer review skipped — skills tree over staging budget");
		h.store.close();
		},
	);
});

describe("/stop cancellation", () => {
	test("stop while skills-ref validates discards staging instead of publishing", async () => {
		const h = harness();
		const binDir = tmpdir_();
		const started = join(binDir, "started");
		const release = join(binDir, "release");
		const bin = join(binDir, "skills-ref");
		writeFileSync(bin, `#!/bin/sh\ntouch "${started}"\nwhile [ ! -e "${release}" ]; do sleep 0.01; done\nexit 0\n`);
		chmodSync(bin, 0o755);
		const deps = h.depsFor({
			nouls: { correction: 0.9, procedure: 0 },
			script: [{ calls: [{ name: "write_file", input: { path: "stopped/SKILL.md", content: SKILL_MD("stopped") } }] }, { text: "saved" }],
		});
		deps.skillsRefBin = bin;
		const pending = considerTurn(deps, turn());
		try {
			for (let i = 0; i < 2000 && !existsSync(started); i++) await Bun.sleep(1);
			// Await the marker rather than a timer: the validator has started.
			expect(existsSync(started)).toBe(true);
			expect(cancelReviews(h.convId)).toBe(1);
		} finally {
			writeFileSync(release, "go");
			await pending;
		}
		expect(readdirSync(h.skills)).not.toContain("stopped");
		expect(readdirSync(h.staging)).toEqual([]);
		expect(h.notified).toEqual([]);
		h.store.close();
	});
	test("abort during model resolution reaches the provider", async () => {
		const h = harness();
		const logFile = join(h.workspace, "goblin.log");
		setLogFile(logFile);
		const deps = h.depsFor({ nouls: { correction: 0.9, procedure: 0 } });
		let release!: () => void;
		const parked = new Promise<void>((resolve) => { release = resolve; });
		const inner = deps.reviewModel;
		let resolving = false;
		deps.reviewModel = async (conv) => {
			resolving = true;
			await parked;
			return inner(conv);
		};
		const pending = considerTurn(deps, turn());
		for (let i = 0; i < 500 && !resolving; i++) await Bun.sleep(1);
		expect(resolving).toBe(true);
		expect(cancelReviews(h.convId)).toBe(1);
		release();
		await pending;
		expect(readdirSync(h.staging)).toEqual([]);
		expect(h.notified).toEqual([]);
		const messages = readFileSync(logFile, "utf8").trim().split("\n")
			.map((line) => (JSON.parse(line) as { msg: string }).msg);
		expect(messages).toContain("reviewer review cancelled — staging discarded");
		expect(messages).not.toContain("review model call");
		h.store.close();
	});
	test("queued reviews are dropped and the in-flight one aborts — staging discarded, live untouched", async () => {
		const h = harness();
		const logFile = join(h.workspace, "goblin.log");
		setLogFile(logFile);
		let release!: () => void;
		const park = new Promise<void>((r) => {
			release = r;
		});
		const deps = h.depsFor({ nouls: { correction: 0.9, procedure: 0.9 } });
		const inner = deps.reviewModel;
		let resolves = 0;
		deps.reviewModel = async (conv) => {
			resolves += 1;
			const n = resolves;
			if (n === 1) {
				return {
					ref: "fake/hang",
					model: fakeReviewModel(
						[
							{ calls: [{ name: "write_file", input: { path: "doomed/SKILL.md", content: SKILL_MD("doomed") } }] },
							{ text: "saved" },
						],
						() => park,
					),
				};
			}
			return inner(conv);
		};
		const p1 = considerTurn(deps, turn({ turnSeq: 1 }));
		for (let i = 0; i < 500 && resolves < 1; i++) await Bun.sleep(1);
		await Bun.sleep(20); // review 1 in-flight at its write step
		const p2 = considerTurn(deps, turn({ turnSeq: 2 }));
		await Bun.sleep(20); // review 2 queued behind the parked one
		expect(cancelReviews("dm:1")).toBe(2);
		release();
		await p1; // cancelled — resolves, not rejects
		await p2;
		// The queued review never started; the in-flight one aborted and
		// discarded its staging; the live catalog never saw a byte.
		expect(resolves).toBe(1);
		expect(() => readFileSync(join(h.skills, "doomed", "SKILL.md"))).toThrow();
		expect(readdirSync(h.staging)).toEqual([]);
		expect(h.notified).toEqual([]);
		const cancelled = readFileSync(logFile, "utf8").trim().split("\n")
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((e) => typeof e.msg === "string" && e.msg.startsWith("reviewer review cancelled"))
			.map((e) => e.msg);
		expect(cancelled).toContain("reviewer review cancelled — dropped from queue");
		expect(cancelled).toContain("reviewer review cancelled — aborting in-flight");
		expect(cancelled).toContain("reviewer review cancelled — staging discarded");
		h.store.close();
	});

	test("cancelling one conversation leaves another's reviews alone", async () => {
		const h = harness();
		let release!: () => void;
		const park = new Promise<void>((r) => {
			release = r;
		});
		const deps = h.depsFor({ nouls: { correction: 0.9, procedure: 0.9 } });
		deps.reviewModel = async () => ({
			ref: "fake/hang",
			model: fakeReviewModel([{ text: "idle" }], () => park),
		});
		const p1 = considerTurn(deps, turn({ conversationId: "dm:1", turnSeq: 1 }));
		await Bun.sleep(50); // review in-flight, parked
		expect(cancelReviews("dm:99")).toBe(0);
		release();
		await p1;
		h.store.close();
	});
});

describe("reviewer evidence payload", () => {
	test("the payload carries tool name, truncated args, truncated result, and ok/fail", async () => {
		const h = harness();
		const prompts: string[] = [];
		const deps = h.depsFor({
			nouls: { correction: 0.1, procedure: 0.95 },
			prompts,
			script: [{ text: "nothing worth saving" }],
		});
		await considerTurn(deps, turn({
			toolDigest: [
				digestEntry(),
				digestEntry({ tool: "read_file", args: '{"path":"a.pdf"}', result: "binary file (a.pdf)", ok: true }),
				digestEntry({ tool: "bash", args: '{"cmd":"rm -rf x"}', result: "command failed: nope", ok: false }),
			],
		}));
		const prompt = prompts.map(promptText).join("\n");
		expect(prompt).toContain("- bash — ok");
		expect(prompt).toContain('args: {"cmd":"ls"}');
		expect(prompt).toContain("result: ok");
		expect(prompt).toContain("- read_file — ok");
		expect(prompt).toContain("- bash — FAILED");
		expect(prompt).toContain("command failed: nope");
		expect(prompt).toContain("Current skills catalog:");
		h.store.close();
	});

	test("a correction trigger includes the prior turn; a procedure trigger does not", async () => {
		const h = harness();
		const prompts: string[] = [];
		const correctionDeps = h.depsFor({
			nouls: { correction: 0.95, procedure: 0.1 },
			prompts,
			script: [{ text: "nothing worth saving" }],
		});
		await considerTurn(correctionDeps, turn(), prior());
		expect(prompts).toHaveLength(1);
		const correctionPrompt = promptText(prompts[0]!);
		expect(correctionPrompt).toContain("The turn this correction refers back to:");
		expect(correctionPrompt).toContain("sort the pdfs");
		expect(correctionPrompt).toContain("sorted them wrongly");
		expect(correctionPrompt).toContain("- read_file — FAILED");

		const procedurePrompts: string[] = [];
		const procedureDeps = h.depsFor({
			nouls: { correction: 0.1, procedure: 0.95 },
			prompts: procedurePrompts,
			script: [{ text: "nothing worth saving" }],
		});
		await considerTurn(procedureDeps, turn(), prior());
		expect(promptText(procedurePrompts[0]!)).not.toContain("refers back to");
		h.store.close();
	});

	test("the latest operator message and the current answer are always present", async () => {
		const h = harness();
		const prompts: string[] = [];
		const deps = h.depsFor({
			nouls: { correction: 0.95, procedure: 0 },
			prompts,
			script: [{ text: "nothing worth saving" }],
		});
		await considerTurn(deps, turn({
			operatorTexts: [`OLDHEAD ${"old noise ".repeat(2000)}TAILMARKER`, "the actual correction"],
			replyText: `HEAD${"x".repeat(20_000)}`,
			toolDigest: new Array(8).fill(digestEntry()),
		}), prior());
		const prompt = promptText(prompts[0]!);
		expect(prompt).toContain("the actual correction");
		expect(prompt).toContain("HEAD");
		// The old message survives only as its bounded tail — its head
		// (and everything older) is dropped first.
		expect(prompt).not.toContain("OLDHEAD");
		h.store.close();
	});

	test("summarize truncates to the limit and marks the cut; toolOk reads the tool shapes", () => {
		const long = "y".repeat(500);
		const cut = summarize({ cmd: long }, 40);
		expect(cut.length).toBeLessThanOrEqual(41);
		expect(cut.endsWith("…")).toBe(true);
		expect(summarize("short", 40)).toBe("short");
		expect(toolOk({ error: "nope" })).toBe(false);
		expect(toolOk({ exit_code: 1 })).toBe(false);
		expect(toolOk({ exit_code: 0 })).toBe(true);
		expect(toolOk({ text: "fine" })).toBe(true);
		expect(toolOk("plain")).toBe(true);
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

	test("a deep, not-yet-existing path inside the root passes", async () => {
		const h = harness();
		const tools = reviewTools(h.skills);
		const write = tools.write_file as unknown as { execute: (i: unknown) => Promise<unknown> };
		expect(await write.execute({ path: "brand/new/SKILL.md", content: SKILL_MD("brand") })).toEqual({
			path: join(h.skills, "brand", "new", "SKILL.md"),
			bytes: expect.any(Number),
		});
		h.store.close();
	});

	test("a symlink inside skills pointing outside is refused for read and write", async () => {
		const h = harness();
		const outside = join(h.workspace, "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.md"), "operator data");
		symlinkSync(outside, join(h.skills, "link"));
		const tools = reviewTools(h.skills);
		const read = tools.read_file as unknown as { execute: (i: unknown) => Promise<unknown> };
		const write = tools.write_file as unknown as { execute: (i: unknown) => Promise<unknown> };
		expect(await read.execute({ path: "link/secret.md" })).toEqual({
			error: expect.stringContaining("escapes the skills directory"),
		});
		expect(await write.execute({ path: "link/new.md", content: "nope" })).toEqual({
			error: expect.stringContaining("escapes the skills directory"),
		});
		expect(() => readFileSync(join(outside, "new.md"))).toThrow();
		h.store.close();
	});

	test("an escaping review writes nothing and publishes nothing", async () => {
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
		const state = buildGateState(turn({ operatorTexts: [], replyText: "", toolNames: [], toolDigest: [] }));
		expect(state).toContain("tools: (none) (0 total)");
	});
});
