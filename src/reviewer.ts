// Skill reviewer — automatic skill saving (DESIGN.md, "Skill reviewer").
//
// Every completed turn is gated: Jev (a typed-decision model, not a chat
// model) answers two noul questions over the turn's state — did the
// operator correct something, did the turn run a repeatable procedure —
// and either at or past the threshold triggers a background review. This
// is an experiment: every gate logs both probabilities, the decision,
// input tokens, cost, and latency, so cost and hit rate are answerable
// from the log. Jev unreachable (any gate failure) falls back to the
// tool-count rule — a turn with 8+ tool calls reviews.
//
// The review itself runs off the conversation lane: the review model
// (the conversation's own, or the reviewer.model override) gets the
// turn transcript plus the skills catalog and read/write/edit tools
// confined to skills/ — no shell. It creates or edits one skill, or
// does nothing. Touched skills must pass `skills-ref validate` or the
// write is reverted; a saved skill posts a note to its topic and lands
// in history as a system event, so the next turn knows.
//
// Fire-and-forget by design: the runtime never awaits a review, and
// shutdown doesn't wait for one either — a missed save on a racing
// shutdown is benign (the next similar turn re-gates) and logged.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { generateText, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import type { ToolCallOptions } from "@ai-sdk/provider-utils";
import { loadCatalog } from "./agent/skills.ts";
import { editFileTool } from "./agent/tools/edit.ts";
import { readFileTool } from "./agent/tools/read.ts";
import { writeFileTool } from "./agent/tools/write.ts";
import { resolvePath } from "./agent/tools/paths.ts";
import type { ConversationStore } from "./conversation.ts";
import { JevError, type JevClient, type JevQuestion } from "./jev.ts";
import { log } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";

// ---------- turn snapshot (the runtime's side) ----------

// What the gate and the review see of a completed turn: the operator
// burst it answered, the reply, and every tool call in order. Built by
// the runtime on the completed path only — fenced and failed turns
// never gate, and the reviewer's own writes submit no turns, so they
// never re-gate.
export interface CompletedTurn {
	conversationId: string;
	operatorTexts: string[];
	replyText: string;
	toolNames: string[];
}

export interface ReviewerDeps {
	gate: Pick<JevClient, "decide">;
	threshold: number;
	// Resolves the review model fresh per review (the mini app owns the
	// default between reviews; the override is config). Labels the call
	// for the model-call wrapper.
	reviewModel(conversationId: string): Promise<{ ref: string; model: LanguageModel }>;
	store: Pick<ConversationStore, "append">;
	skillsDir: string;
	workspaceDir: string;
	// Posts the saved-skill note to the topic. History is already
	// written when this runs — a delivery failure logs, it doesn't
	// unpick the save.
	notify(conversationId: string, skills: string[]): Promise<void>;
	/** Test door — the production path always uses `skills-ref`. */
	skillsRefBin?: string;
}

// ---------- gate ----------

const GATE_QUESTIONS: Record<string, JevQuestion> = {
	correction: {
		type: "noul",
		instructions:
			"Did the operator correct how the assistant did something — point out a mistake, restate a preference, or redirect the approach?",
		criteria: {
			true: "The operator corrected a mistake, restated a preference, or redirected the approach",
			false: "No correction: the operator asked, answered, or acknowledged without redirecting",
		},
	},
	procedure: {
		type: "noul",
		instructions:
			"Did the turn carry out a repeatable multi-step procedure — a sequence of tool calls or steps worth saving as a reusable skill?",
		criteria: {
			true: "A repeatable multi-step procedure was carried out",
			false: "A one-off answer, chat, or single-step task with nothing worth reusing",
		},
	},
};

// Jev's context is 32k tokens — the state stays an order of magnitude
// under it. Operator text reads tail-first (a correction lands in the
// latest message); the reply reads head-first.
const MAX_OPERATOR_CHARS = 10_000;
const MAX_REPLY_CHARS = 12_000;
// The fallback rule when Jev is unreachable (DESIGN.md).
const FALLBACK_TOOL_CALLS = 8;

export function buildGateState(turn: CompletedTurn): string {
	const counts = new Map<string, number>();
	for (const name of turn.toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
	const tools = [...counts.entries()].map(([name, n]) => (n === 1 ? name : `${name} ×${n}`)).join(", ");
	return [
		"operator:",
		turn.operatorTexts.join("\n---\n").slice(-MAX_OPERATOR_CHARS),
		"",
		"assistant reply:",
		turn.replyText.slice(0, MAX_REPLY_CHARS),
		"",
		`tools: ${tools === "" ? "(none)" : tools} (${turn.toolNames.length} total)`,
	].join("\n");
}

export async function considerTurn(deps: ReviewerDeps, turn: CompletedTurn): Promise<void> {
	const started = Date.now();
	const state = buildGateState(turn);
	try {
		const decision = await deps.gate.decide(state, GATE_QUESTIONS);
		const correction = decision.answers["correction"] ?? 0;
		const procedure = decision.answers["procedure"] ?? 0;
		const review = correction >= deps.threshold || procedure >= deps.threshold;
		// The experiment line: every gate answers cost and hit rate.
		log.info("reviewer gate", {
			conversation: turn.conversationId,
			correction,
			procedure,
			threshold: deps.threshold,
			review,
			fallback: false,
			toolCalls: turn.toolNames.length,
			inputTokens: decision.inputTokens,
			cost: decision.cost,
			ms: Date.now() - started,
		});
		if (review) await runReview(deps, turn);
	} catch (err) {
		// Only the gate's own failures fall back — anything else is a
		// bug and propagates to the runtime's backstop, loud.
		if (!(err instanceof JevError)) throw err;
		const review = turn.toolNames.length >= FALLBACK_TOOL_CALLS;
		log.info("reviewer gate", {
			conversation: turn.conversationId,
			correction: null,
			procedure: null,
			threshold: deps.threshold,
			review,
			fallback: true,
			reason: err.message,
			toolCalls: turn.toolNames.length,
			inputTokens: null,
			cost: null,
			ms: Date.now() - started,
		});
		if (review) await runReview(deps, turn);
	}
}

// ---------- review ----------

// A review is a bounded background call, not a turn: ten steps against
// three file tools, five minutes wall-clock, then it aborts and whatever
// it wrote is validated-or-reverted like any other outcome.
const REVIEW_MAX_STEPS = 10;
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
// The transcript is evidence, not the turn's full context — bounded.
const MAX_REVIEW_TRANSCRIPT_CHARS = 12_000;
// A runaway review writes big — over this many new bytes the write is
// reverted unvalidated. Skills are small text; this is 10x a large one.
const MAX_REVIEW_BYTES = 100 * 1024;
// Snapshot caps: a skills tree bigger than this is already wrong — skip
// the review (loud) rather than copy it.
const MAX_SNAPSHOT_FILES = 512;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

const REVIEW_SYSTEM =
	"You are goblin's skill reviewer. A just-completed turn looked worth distilling into a skill. " +
	"Your working directory IS the skills catalog: read `<name>/SKILL.md` to inspect a skill, " +
	"write `<name>/SKILL.md` (plus any helper files the skill needs) to create or replace one. " +
	"Decide, then act:\n" +
	"- Create ONE skill when the turn taught a repeatable multi-step procedure no skill covers.\n" +
	"- Edit ONE skill when an existing skill is wrong or incomplete about what the turn showed.\n" +
	"- Otherwise do nothing: make no tool calls and say so briefly.\n" +
	"SKILL.md frontmatter needs `name` (exactly its directory name) and `description`. " +
	"Keep skills small and concrete — steps the future turn can follow, not essays.";

function reviewPrompt(turn: CompletedTurn, catalogLines: string[]): string {
	const operator = turn.operatorTexts.join("\n---\n");
	const transcript = `operator:\n${operator}\n\nassistant reply:\n${turn.replyText}`.slice(
		0,
		MAX_REVIEW_TRANSCRIPT_CHARS,
	);
	return [
		"The turn:",
		"",
		transcript,
		"",
		`tools used: ${turn.toolNames.length === 0 ? "(none)" : [...new Set(turn.toolNames)].join(", ")}`,
		"",
		"Current skills catalog:",
		"",
		...(catalogLines.length === 0 ? ["(none yet)"] : catalogLines),
	].join("\n");
}

// Lexical confinement: paths resolving outside the skills root refuse.
// Complete against this tool set — read/write/edit create no symlinks,
// so nothing under the root can resolve out from under the check. (An
// operator-planted symlink pointing out is the operator's own link;
// the trio's behavior through it matches the main agent's.)
export function confineTools(tools: ToolSet, root: string): ToolSet {
	const resolved = resolve(root);
	for (const t of Object.values(tools)) {
		const execute = t.execute?.bind(t);
		if (execute === undefined) continue;
		t.execute = (input: unknown, options: ToolCallOptions) => {
			const path = (input as { path?: unknown } | null)?.path;
			if (typeof path !== "string" || escapesRoot(resolved, path)) {
				const shown = typeof path === "string" ? path.slice(0, 200) : "(missing)";
				return Promise.resolve({ error: `path escapes the skills directory: ${shown}` } as never);
			}
			return execute(input as never, options);
		};
	}
	return tools;
}

function escapesRoot(root: string, path: string): boolean {
	const abs = resolvePath(root, path);
	return abs !== root && !abs.startsWith(root + sep);
}

export function reviewTools(skillsDir: string): ToolSet {
	return confineTools(
		{
			read_file: readFileTool(skillsDir),
			write_file: writeFileTool(skillsDir),
			edit_file: editFileTool(skillsDir),
		},
		skillsDir,
	);
}

// ---------- snapshot / revert ----------

interface SkillsSnapshot {
	files: Map<string, Uint8Array>;
	dirs: Set<string>;
}

function walkSkills(root: string, maxFiles: number, maxBytes: number, what: string): SkillsSnapshot {
	const files = new Map<string, Uint8Array>();
	const dirs = new Set<string>(["."]);
	let bytes = 0;
	const walk = (rel: string): void => {
		const abs = rel === "." ? root : join(root, rel);
		let dirents;
		try {
			dirents = readdirSync(abs, { withFileTypes: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT" && rel === ".") return;
			throw err;
		}
		for (const dirent of dirents) {
			const child = rel === "." ? dirent.name : `${rel}/${dirent.name}`;
			// statSync follows symlinks, like the catalog loader — a
			// linked-in skill snapshots by content, same as it reads.
			const stats = statSync(join(root, child));
			if (stats.isDirectory()) {
				dirs.add(child);
				walk(child);
			} else if (stats.isFile()) {
				const content = readFileSync(join(root, child));
				files.set(child, content);
				bytes += content.byteLength;
				if (files.size > maxFiles || bytes > maxBytes) {
					throw new Error(`${what} exceeds the snapshot budget (${maxFiles} files / ${maxBytes} bytes)`);
				}
			}
		}
	};
	walk(".");
	return { files, dirs };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));
}

/** Rel paths whose bytes differ between the snapshots (either direction). */
function diffSnapshots(before: SkillsSnapshot, after: SkillsSnapshot): string[] {
	const changed: string[] = [];
	for (const [rel, content] of after.files) {
		const prev = before.files.get(rel);
		if (!prev || !sameBytes(prev, content)) changed.push(rel);
	}
	for (const rel of before.files.keys()) {
		if (!after.files.has(rel)) changed.push(rel);
	}
	return changed.sort();
}

function restoreSnapshot(root: string, snapshot: SkillsSnapshot): void {
	const current = walkSkills(root, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "revert scan");
	for (const rel of current.files.keys()) {
		if (!snapshot.files.has(rel)) rmSync(join(root, rel));
	}
	for (const [rel, content] of snapshot.files) {
		const prev = current.files.get(rel);
		if (!prev || !sameBytes(prev, content)) {
			mkdirSync(dirname(join(root, rel)), { recursive: true });
			writeFileSync(join(root, rel), content);
		}
	}
	// Newly created dirs, deepest first — rmdir of a non-empty dir
	// throws, so depth order is the whole algorithm.
	const gone = [...current.dirs].filter((d) => !snapshot.dirs.has(d)).sort().reverse();
	for (const dir of gone) rmSync(join(root, dir), { recursive: true });
}

// ---------- validate ----------

interface ValidateOutcome {
	ok: boolean;
	output: string;
}

async function validateSkill(deps: ReviewerDeps, skill: string): Promise<ValidateOutcome> {
	const bin = deps.skillsRefBin ?? "skills-ref";
	let proc: ReturnType<typeof spawnProc>;
	try {
		proc = spawnProc([bin, "validate", `./skills/${skill}`], deps.workspaceDir);
	} catch (err) {
		return { ok: false, output: `cannot run ${bin}: ${(err as Error).message}` };
	}
	const result = await boundedRun(proc, { timeoutMs: 30_000, maxOutput: 64 * 1024 });
	const output = `${result.stdout}\n${result.stderr}`.trim().slice(-2000);
	if (result.timedOut) return { ok: false, output: "validation timed out" };
	if (result.exitCode === null) return { ok: false, output: "validation could not be reaped" };
	return result.exitCode === 0
		? { ok: true, output }
		: { ok: false, output: output === "" ? `exit ${result.exitCode}` : output };
}

// ---------- review run ----------

async function runReview(deps: ReviewerDeps, turn: CompletedTurn): Promise<void> {
	const conv = turn.conversationId;
	let snapshot: SkillsSnapshot;
	try {
		snapshot = walkSkills(deps.skillsDir, MAX_SNAPSHOT_FILES, MAX_SNAPSHOT_BYTES, "skills catalog");
	} catch (err) {
		log.warn("reviewer review skipped — skills tree over snapshot budget", {
			conversation: conv,
			error: (err as Error).message,
		});
		return;
	}
	const catalog = loadCatalog(deps.skillsDir);
	const catalogLines = catalog.entries.map((e) => `- ${e.name} — ${e.description}`);
	const { ref, model } = await deps.reviewModel(conv);
	log.info("reviewer review started", { conversation: conv, model: ref });
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);
	try {
		const result = await generateText({
			model,
			system: REVIEW_SYSTEM,
			prompt: reviewPrompt(turn, catalogLines),
			tools: reviewTools(deps.skillsDir),
			stopWhen: stepCountIs(REVIEW_MAX_STEPS),
			abortSignal: controller.signal,
		});
		// A model call is a cost line even backstage (the title-call rule).
		log.info("review model call", {
			conversation: conv,
			model: ref,
			usage: {
				input: result.usage.inputTokens ?? null,
				cached: result.usage.cachedInputTokens ?? null,
				output: result.usage.outputTokens ?? null,
			},
			steps: result.steps.length,
		});
		let after: SkillsSnapshot;
		try {
			after = walkSkills(deps.skillsDir, MAX_SNAPSHOT_FILES, MAX_SNAPSHOT_BYTES, "reviewed skills tree");
		} catch (err) {
			// The model grew the tree past the budget — unassessable means
			// unkeepable: revert best-effort and fail loud.
			restoreSnapshot(deps.skillsDir, snapshot);
			log.error("reviewer write reverted — reviewed tree over snapshot budget", err, {
				conversation: conv,
			});
			return;
		}
		const changed = diffSnapshots(snapshot, after);
		if (changed.length === 0) {
			log.info("reviewer review done", { conversation: conv, changed: false, skills: [] });
			return;
		}
		const changedBytes = changed.reduce((n, rel) => n + (after.files.get(rel)?.byteLength ?? 0), 0);
		if (changedBytes > MAX_REVIEW_BYTES) {
			restoreSnapshot(deps.skillsDir, snapshot);
			log.warn("reviewer write reverted — over the byte budget", {
				conversation: conv,
				bytes: changedBytes,
				files: changed.length,
			});
			return;
		}
		// Ground truth from disk, not from the model's tool calls: every
		// top-level dir it touched is a skill to validate.
		const skills = [...new Set(changed.map((rel) => rel.split("/")[0]!))].sort();
		const failures: { skill: string; output: string }[] = [];
		for (const skill of skills) {
			const outcome = await validateSkill(deps, skill);
			if (!outcome.ok) failures.push({ skill, output: outcome.output });
		}
		if (failures.length > 0) {
			restoreSnapshot(deps.skillsDir, snapshot);
			log.warn("reviewer write reverted — skills-ref validate failed", {
				conversation: conv,
				skills,
				failures: failures.map((f) => `${f.skill}: ${f.output.slice(0, 300)}`),
			});
			return;
		}
		// It writes, then tells: history first (the durable record), the
		// topic note second. An undo request next turn deletes these dirs.
		const names = skills.join(", ");
		deps.store.append(conv, [{
			id: randomUUID(),
			role: "system",
			parts: [{
				type: "text",
				text: `saved skill: ${names} — announced in this topic with an undo invite; ` +
					`an undo request means deleting ${skills.map((s) => `skills/${s}/`).join(", ")}`,
			}],
		}]);
		try {
			await deps.notify(conv, skills);
		} catch (err) {
			log.error("skill saved notice failed — history event already written", err, {
				conversation: conv,
				skills,
			});
		}
		log.info("reviewer review done", { conversation: conv, changed: true, skills });
	} finally {
		clearTimeout(timeout);
	}
}
