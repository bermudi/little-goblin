// Skill reviewer — automatic skill saving (DESIGN.md, "Skill reviewer").
//
// Every completed turn is gated: Jev (a typed-decision model, not a chat
// model) answers two noul questions over the turn's state — did the
// operator correct something, did the turn run a repeatable procedure —
// and either at or past its per-question threshold triggers a background
// review. This is an experiment: every gate logs both probabilities, the
// thresholds, the trigger, unique tool names, the consecutive-fallback
// count, the decision, input tokens, cost, and latency, so cost, hit
// rate, and outage drift are answerable from the log. Jev unreachable
// (any gate failure) falls back to the tool-count rule — a turn with 8+
// tool calls reviews.
//
// The review runs off the conversation lane in a private staging copy of
// the skills tree (workspace/.reviewer-staging/<review_id>/skills):
// read/write/edit confined there by lexical AND realpath checks, no
// shell. It creates or edits one skill, or does nothing. Nothing live is
// touched until the staged writes pass `skills-ref validate`; then each
// changed skill is published into skills/ by an atomic directory swap,
// skipped if the live copy changed mid-review (operator edits are never
// clobbered), and rolled back if the swap itself fails. Any failure —
// model call, budget, validation, publish — discards the staging copy
// and leaves the live catalog byte-identical. A published skill posts a
// note to its topic and lands in history as a system event.
//
// Reviews queue in turn-completion order (a monotonic seq from the
// runtime), capped (default 3; a full queue drops the incoming review
// and logs it) and serialize one at a time. /stop cancels a
// conversation's queued reviews and aborts its in-flight one (the
// operator's panic lever stops background skill-writes too).
// Memory-excluded conversations never gate at all — off the record means
// no durable distillation. Fire-and-forget by design: the runtime never
// awaits a review, and shutdown doesn't wait for one either — a missed
// save on a racing shutdown is benign (the next similar turn re-gates)
// and logged.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { generateText, isStepCount, type LanguageModel, type ToolSet } from "ai";
import type { ToolExecutionOptions } from "@ai-sdk/provider-utils";
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

// What the gate and the review see of one tool call: name, bounded
// arguments, bounded result, and whether it succeeded. Built by the
// runtime during the turn (the stream is gone once it ends), ring-capped
// to the last `evidence.calls` calls — lossy by design, cheap by design.
export interface ToolCallDigest {
	tool: string;
	args: string;
	result: string;
	ok: boolean;
}

export interface CompletedTurn {
	conversationId: string;
	/** Monotonic completion counter — the queue's serialization order. */
	turnSeq: number;
	operatorTexts: string[];
	replyText: string;
	/** Every tool call name, in order — the gate's counts. */
	toolNames: string[];
	/** Last-N bounded digest — the review's evidence. */
	toolDigest: ToolCallDigest[];
}

// The previous completed turn, attached when the gate fires on a
// correction: what the operator is correcting is usually the turn
// before, and the reviewer needs to see the wrong answer to distill
// the right one.
export interface PriorTurnContext {
	operatorTexts: string[];
	replyText: string;
	toolDigest: ToolCallDigest[];
}

export type Trigger = "correction" | "procedure";

export interface EvidenceLimits {
	/** Tool calls kept in the digest ring (per turn). */
	calls: number;
	/** Truncation for each call's serialized arguments. */
	argChars: number;
	/** Truncation for each call's serialized result. */
	outChars: number;
}

export interface ReviewerDeps {
	gate: Pick<JevClient, "decide">;
	thresholds: { correction: number; procedure: number };
	/** Queued (not running) review cap; full queue drops the incoming. */
	queueCap: number;
	evidence: EvidenceLimits;
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

// ---------- digest capture helpers (runtime side) ----------

// Stringify + truncate a tool call's input/result for the digest. Never
// throws: an unserializable value degrades to its String() form.
export function summarize(value: unknown, limit: number): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (text === undefined) text = "undefined";
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// ok/fail for a tool result across the tool set's shapes: an error
// field means refused/failed, an exit-code field means the process's
// verdict, anything else ran to completion.
export function toolOk(output: unknown): boolean {
	if (typeof output !== "object" || output === null) return true;
	const o = output as Record<string, unknown>;
	if ("error" in o && o.error) return false;
	if (typeof o.exit_code === "number") return o.exit_code === 0;
	if (typeof o.exitCode === "number") return o.exitCode === 0;
	return true;
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
// latest message); the reply reads head-first. Deliberately lean: names
// and counts only — the digest is the reviewer's evidence, not the
// gate's (a heavy gate is a non-goal).
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

// Calibration counter: how many gates in a row fell back. Reset by any
// successful gate. Module state is process-wide by design — an outage
// is an outage regardless of which conversation noticed.
let fallbackStreak = 0;

export async function considerTurn(
	deps: ReviewerDeps,
	turn: CompletedTurn,
	priorTurn?: PriorTurnContext,
): Promise<void> {
	const started = Date.now();
	const state = buildGateState(turn);
	// Unique tool names, bounded — the gate line must explain what kind
	// of turn scored what without a second lookup.
	const toolNames = [...new Set(turn.toolNames)].slice(0, 16);
	try {
		const decision = await deps.gate.decide(state, GATE_QUESTIONS);
		fallbackStreak = 0;
		const correction = decision.answers["correction"] ?? 0;
		const procedure = decision.answers["procedure"] ?? 0;
		const corrHit = correction >= deps.thresholds.correction;
		const procHit = procedure >= deps.thresholds.procedure;
		const review = corrHit || procHit;
		// A correction carries the prior turn as evidence; when both
		// questions fire, correction wins the trigger.
		const trigger: Trigger = corrHit ? "correction" : "procedure";
		const reviewId = review ? randomUUID() : null;
		// The experiment line: every gate answers cost, hit rate, and
		// outage drift from the log alone.
		log.info("reviewer gate", {
			conversation: turn.conversationId,
			correction,
			procedure,
			thresholds: { correction: deps.thresholds.correction, procedure: deps.thresholds.procedure },
			review,
			trigger: review ? trigger : null,
			review_id: reviewId,
			fallback: false,
			fallbackStreak,
			tools: toolNames,
			toolCalls: turn.toolNames.length,
			inputTokens: decision.inputTokens,
			cost: decision.cost,
			ms: Date.now() - started,
		});
		if (review) await enqueueReview(deps, turn, trigger === "correction" ? priorTurn : undefined, trigger, reviewId!);
	} catch (err) {
		// Only the gate's own failures fall back — anything else is a
		// bug and propagates to the runtime's backstop, loud.
		if (!(err instanceof JevError)) throw err;
		fallbackStreak += 1;
		const review = turn.toolNames.length >= FALLBACK_TOOL_CALLS;
		const trigger: Trigger = "procedure";
		const reviewId = review ? randomUUID() : null;		log.info("reviewer gate", {
			conversation: turn.conversationId,
			correction: null,
			procedure: null,
			thresholds: { correction: deps.thresholds.correction, procedure: deps.thresholds.procedure },
			review,
			trigger: review ? trigger : null,
			review_id: reviewId,
			fallback: true,
			fallbackStreak,
			reason: err.message,
			tools: toolNames,
			toolCalls: turn.toolNames.length,
			inputTokens: null,
			cost: null,
			ms: Date.now() - started,
		});
		if (review) await enqueueReview(deps, turn, undefined, trigger, reviewId!);
	}
}

// ---------- review queue ----------
//
// Reviews serialize one at a time, in turn-completion order (turnSeq),
// queued-not-running capped at queueCap. Overlapping runs would publish
// over each other's announced writes; gate-latency ordering would let a
// slow gate leapfrog a faster later turn. A full queue drops the
// incoming review (the newest turn is the most re-gateable — the next
// similar turn re-fires) and logs the drop. /stop cancels a
// conversation's queued reviews and aborts its in-flight one.

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface QueueEntry {
	seq: number;
	reviewId: string;
	conversationId: string;
	deps: ReviewerDeps;
	turn: CompletedTurn;
	prior: PriorTurnContext | undefined;
	trigger: Trigger;
	cancelled: boolean;
	done: Deferred<void>;
}

let reviewQueue: QueueEntry[] = [];
let inFlight: { entry: QueueEntry; controller: AbortController } | null = null;

/** /stop (and shutdown via stop): cancel a conversation's reviews.
 * Queued entries are removed and resolved; the in-flight one (if the
 * conversation's) is aborted — its staging is discarded by the normal
 * failure path. Returns how many were cancelled. */
export function cancelReviews(conversationId: string): number {
	let n = 0;
	for (const entry of [...reviewQueue]) {
		if (entry.conversationId !== conversationId || entry.cancelled) continue;
		entry.cancelled = true;
		reviewQueue.splice(reviewQueue.indexOf(entry), 1);
		entry.done.resolve();
		log.info("reviewer review cancelled — dropped from queue", {
			review_id: entry.reviewId,
			conversation: conversationId,
			seq: entry.seq,
		});
		n += 1;
	}
	if (inFlight !== null && inFlight.entry.conversationId === conversationId && !inFlight.entry.cancelled) {
		inFlight.entry.cancelled = true;
		inFlight.controller.abort();
		log.info("reviewer review cancelled — aborting in-flight", {
			review_id: inFlight.entry.reviewId,
			conversation: conversationId,
			seq: inFlight.entry.seq,
		});
		n += 1;
	}
	return n;
}

/** Test door — isolate queue + streak state between tests. */
export function resetReviewerState(): void {
	reviewQueue = [];
	if (inFlight !== null) inFlight.controller.abort();
	inFlight = null;
	fallbackStreak = 0;
}

function enqueueReview(
	deps: ReviewerDeps,
	turn: CompletedTurn,
	prior: PriorTurnContext | undefined,
	trigger: Trigger,
	reviewId: string,
): Promise<void> {
	if (reviewQueue.length >= deps.queueCap) {
		log.warn("reviewer queue full — review dropped", {
			review_id: reviewId,
			conversation: turn.conversationId,
			seq: turn.turnSeq,
			queued: reviewQueue.length,
			cap: deps.queueCap,
		});
		return Promise.resolve();
	}
	const entry: QueueEntry = {
		seq: turn.turnSeq,
		reviewId,
		conversationId: turn.conversationId,
		deps,
		turn,
		prior,
		trigger,
		cancelled: false,
		done: deferred<void>(),
	};
	// Insert in completion order — gates resolve out of order whenever
	// two conversations complete close together.
	const idx = reviewQueue.findIndex((e) => e.seq > entry.seq);
	reviewQueue.splice(idx === -1 ? reviewQueue.length : idx, 0, entry);
	drainQueue();
	// The caller resolves only when ITS OWN review settles (or is
	// dropped/cancelled — policy outcomes, not errors).
	return entry.done.promise;
}

function drainQueue(): void {
	if (inFlight !== null || reviewQueue.length === 0) return;
	const entry = reviewQueue.shift()!;
	const controller = new AbortController();
	inFlight = { entry, controller };
	void runReview(entry, controller.signal)
		.catch((err: unknown) => {
			// A thrown review is a bug (staging setup, publish mechanics)
			// — it propagates to the runtime's backstop, loud, without
			// poisoning the next queued review.
			entry.done.reject(err);
		})
		.finally(() => {
			inFlight = null;
			entry.done.resolve();
			drainQueue();
		});
}

// ---------- review ----------

// A review is a bounded background call, not a turn: ten steps against
// three file tools, five minutes wall-clock, then it aborts and its
// staging is discarded like any other failure.
const REVIEW_MAX_STEPS = 10;
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
// The transcript is evidence, not the turn's full context — bounded.
// The digest and prior-turn blocks carry their own budgets, so the
// worst-case prompt stays ~30k chars.
const MAX_REVIEW_TRANSCRIPT_CHARS = 12_000;
// The prior (corrected) turn gets smaller budgets than the live one —
// when space is tight, the correction, the wrong turn, and the current
// answer win; anything older is dropped first (operator text reads
// tail-first, reply head-first).
const PRIOR_MAX_OPERATOR_CHARS = 4_000;
const PRIOR_MAX_REPLY_CHARS = 6_000;
// A runaway review writes big — over this many staged bytes the write is
// discarded unvalidated. Skills are small text; this is 10x a large one.
const MAX_REVIEW_BYTES = 100 * 1024;
// Staging copy caps: a skills tree bigger than this is already wrong —
// skip the review (loud) rather than copy it.
const MAX_STAGING_FILES = 512;
const MAX_STAGING_BYTES = 2 * 1024 * 1024;
// Staging lives beside skills/ in the workspace — same filesystem, so
// publish is a real rename, and dot-prefixed so no catalog scan sees it.
const STAGING_DIRNAME = ".reviewer-staging";

export function stagingRoot(workspaceDir: string): string {
	return join(workspaceDir, STAGING_DIRNAME);
}

/** Boot-time hygiene: staging from a killed run can only be garbage. */
export function cleanupStaging(workspaceDir: string): void {
	rmSync(stagingRoot(workspaceDir), { recursive: true, force: true });
}

const REVIEW_SYSTEM =
	"You are goblin's skill reviewer. A just-completed turn looked worth distilling into a skill. " +
	"Your working directory IS the skills catalog (a private copy — your writes publish only after they validate): " +
	"read `<name>/SKILL.md` to inspect a skill, " +
	"write `<name>/SKILL.md` (plus any helper files the skill needs) to create or replace one. " +
	"The turn's evidence includes each tool call's truncated arguments and result — a failed call is marked FAILED. " +
	"On a correction, the block 'the turn this correction refers back to' shows what went wrong the first time. " +
	"Decide, then act:\n" +
	"- Create ONE skill when the turn taught a repeatable multi-step procedure no skill covers.\n" +
	"- Edit ONE skill when an existing skill is wrong or incomplete about what the turn showed.\n" +
	"- Otherwise do nothing: make no tool calls and say so briefly.\n" +
	"SKILL.md frontmatter needs `name` (exactly its directory name) and `description`. " +
	"Keep skills small and concrete — steps the future turn can follow, not essays.";

function digestLines(digest: ToolCallDigest[]): string[] {
	if (digest.length === 0) return ["(no tool calls)"];
	const lines: string[] = [];
	for (const d of digest) {
		lines.push(`- ${d.tool} — ${d.ok ? "ok" : "FAILED"}`);
		lines.push(`  args: ${d.args === "" ? "(none)" : d.args}`);
		lines.push(`  result: ${d.result === "" ? "(no result)" : d.result}`);
	}
	return lines;
}

export function reviewPrompt(
	turn: CompletedTurn,
	prior: PriorTurnContext | undefined,
	catalogLines: string[],
): string {
	// Tail-first operator, head-first reply — when space is tight the
	// latest operator message and the current answer always survive.
	const operator = turn.operatorTexts.join("\n---\n").slice(-MAX_OPERATOR_CHARS);
	const transcript = `operator:\n${operator}\n\nassistant reply:\n${turn.replyText.slice(0, MAX_REPLY_CHARS)}`.slice(
		0,
		MAX_REVIEW_TRANSCRIPT_CHARS,
	);
	return [
		"The turn:",
		"",
		transcript,
		"",
		`tool calls in the turn (last ${turn.toolDigest.length}, arguments and results truncated):`,
		...digestLines(turn.toolDigest),
		...(prior !== undefined
			? [
					"",
					"The turn this correction refers back to:",
					"",
					`operator:\n${prior.operatorTexts.join("\n---\n").slice(-PRIOR_MAX_OPERATOR_CHARS)}`,
					"",
					`assistant reply:\n${prior.replyText.slice(0, PRIOR_MAX_REPLY_CHARS)}`,
					"",
					"its tool calls (truncated):",
					...digestLines(prior.toolDigest),
				]
			: []),
		"",
		"Current skills catalog:",
		"",
		...(catalogLines.length === 0 ? ["(none yet)"] : catalogLines),
	].join("\n");
}

// ---------- confinement ----------
//
// Paths refusing outside the skills root: lexical (`..`) first, then
// real resolution — an existing symlink inside the root that points out
// must not carry a read or write out with it. The root itself is
// realpath'd once; a candidate is resolved through its deepest existing
// ancestor (a not-yet-existing tail can't introduce a symlink). TOCTOU
// on the operator's own tree is out of scope; in staging the tree is a
// fresh copy the review itself is the only writer of.
export function confineTools(tools: ToolSet, root: string): ToolSet {
	const resolved = resolve(root);
	const realRoot = realpathSync(resolved);
	for (const t of Object.values(tools)) {
		const execute = t.execute?.bind(t);
		if (execute === undefined) continue;
		t.execute = (input: unknown, options: ToolExecutionOptions<unknown>) => {
			const path = (input as { path?: unknown } | null)?.path;
			if (typeof path !== "string" || escapesRoot(resolved, realRoot, path)) {
				const shown = typeof path === "string" ? path.slice(0, 200) : "(missing)";
				return Promise.resolve({ error: `path escapes the skills directory: ${shown}` } as never);
			}
			return execute(input as never, options);
		};
	}
	return tools;
}

function escapesRoot(root: string, realRoot: string, path: string): boolean {
	const abs = resolvePath(root, path);
	if (abs !== root && !abs.startsWith(root + sep)) return true;
	return !realUnder(realRoot, abs);
}

/** True when `abs` (after resolving symlinks) stays inside `realRoot`. */
function realUnder(realRoot: string, abs: string): boolean {
	let dir = dirname(abs);
	let tail = basename(abs);
	for (;;) {
		let real: string;
		try {
			real = realpathSync(dir);
		} catch {
			// Climb to the deepest existing ancestor; at the filesystem
			// root without a match, or anything unreadable, refuse.
			const parent = dirname(dir);
			if (parent === dir) return false;
			tail = join(basename(dir), tail);
			dir = parent;
			continue;
		}
		const realAbs = tail === "" ? real : join(real, tail);
		return realAbs === realRoot || realAbs.startsWith(realRoot + sep);
	}
}

// `written`, when passed, collects the staging-root-relative paths the
// write tools actually wrote — the review's attribution set, for changed
// detection and the log lines. Recorded from each tool's *result* path:
// a refused or failed write reports no path and records nothing.
export function reviewTools(skillsDir: string, written?: Set<string>): ToolSet {
	const tools = confineTools(
		{
			read_file: readFileTool(skillsDir),
			write_file: writeFileTool(skillsDir),
			edit_file: editFileTool(skillsDir),
		},
		skillsDir,
	);
	if (written === undefined) return tools;
	const root = resolve(skillsDir);
	for (const name of ["write_file", "edit_file"] as const) {
		const t = tools[name];
		if (t === undefined) continue;
		const execute = t.execute?.bind(t);
		if (execute === undefined) continue;
		t.execute = async (input: unknown, options: ToolExecutionOptions<unknown>) => {
			const result = await execute(input as never, options);
			const path = (result as { path?: unknown } | null | undefined)?.path;
			if (typeof path === "string") {
				const abs = resolve(path);
				if (abs !== root && abs.startsWith(root + sep)) written.add(relative(root, abs));
			}
			return result;
		};
	}
	return tools;
}

// ---------- staging copy ----------

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Copy the live skills tree into `stagedDir` (created), flattening
 * symlinks by content, and return path → sha256 of what was copied.
 * Throws over the file/byte budget — the caller skips the review loud.
 * A missing live root copies as an empty catalog. */
function copySkillsTree(skillsDir: string, stagedDir: string): Map<string, string> {
	const manifest = new Map<string, string>();
	mkdirSync(stagedDir, { recursive: true });
	// A missing live root copies as an empty catalog — first skill ever.
	if (!existsSync(skillsDir)) return manifest;
	let bytes = 0;
	const walk = (srcRel: string): void => {
		const srcAbs = srcRel === "." ? skillsDir : join(skillsDir, srcRel);
		for (const dirent of readdirSync(srcAbs, { withFileTypes: true })) {
			const rel = srcRel === "." ? dirent.name : `${srcRel}/${dirent.name}`;
			// statSync follows symlinks, like the catalog loader — a
			// linked-in skill copies by content, never as a link.
			const stats = statSync(join(skillsDir, rel));
			if (stats.isDirectory()) {
				mkdirSync(join(stagedDir, rel), { recursive: true });
				walk(rel);
			} else if (stats.isFile()) {
				const content = readFileSync(join(skillsDir, rel));
				manifest.set(rel, sha256(content));
				mkdirSync(dirname(join(stagedDir, rel)), { recursive: true });
				writeFileSync(join(stagedDir, rel), content);
				bytes += content.byteLength;
				if (manifest.size > MAX_STAGING_FILES || bytes > MAX_STAGING_BYTES) {
					throw new Error(`skills tree exceeds the staging budget (${MAX_STAGING_FILES} files / ${MAX_STAGING_BYTES} bytes)`);
				}
			}
		}
	};
	walk(".");
	return manifest;
}

/** Which written paths actually differ from the copied manifest (or are
 * new), plus their combined staged size — the review's candidate
 * changes, attribution-scoped to its own writes. */
function changedPaths(
	stagedDir: string,
	manifest: Map<string, string>,
	written: Set<string>,
): { changed: string[]; bytes: number } {
	const changed: string[] = [];
	let bytes = 0;
	for (const rel of [...written].sort()) {
		const abs = join(stagedDir, rel);
		let stats;
		try {
			stats = statSync(abs);
		} catch {
			// Written, then gone from staging — only the review writes
			// there, so this is a tool lie; don't publish it.
			continue;
		}
		const prev = manifest.get(rel);
		if (prev !== undefined && sha256(readFileSync(abs)) === prev) continue;
		changed.push(rel);
		bytes += stats.size;
	}
	return { changed, bytes };
}

// ---------- validate ----------

interface ValidateOutcome {
	ok: boolean;
	output: string;
}

async function validateSkill(deps: ReviewerDeps, cwd: string, skill: string): Promise<ValidateOutcome> {
	const bin = deps.skillsRefBin ?? "skills-ref";
	let proc: ReturnType<typeof spawnProc>;
	try {
		proc = spawnProc([bin, "validate", `./skills/${skill}`], cwd);
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

// ---------- publish ----------

type PublishOutcome = { published: true } | { published: false; reason: "conflict"; drifted: string[] };

/** Does the live skill dir still byte-match the copy the review worked
 * from? Operator edits, undos, or hand-added files mid-review are never
 * clobbered — the skill is skipped instead. */
function liveDrifted(
	skillsDir: string,
	manifest: Map<string, string>,
	skill: string,
): string[] {
	const prefix = `${skill}/`;
	const expected = new Map(
		[...manifest.entries()].filter(([rel]) => rel.startsWith(prefix)),
	);
	const drifted: string[] = [];
	const liveSkill = join(skillsDir, skill);
	if (!existsSync(liveSkill)) {
		// Not in the manifest either → brand-new skill, nothing to drift.
		if (expected.size === 0) return [];
		return [...expected.keys()];
	}
	const walk = (rel: string): void => {
		const abs = rel === "." ? liveSkill : join(liveSkill, rel);
		for (const dirent of readdirSync(abs, { withFileTypes: true })) {
			const child = rel === "." ? dirent.name : `${rel}/${dirent.name}`;
			const childRel = `${skill}/${child}`;
			const stats = statSync(join(liveSkill, child));
			if (stats.isDirectory()) {
				walk(child);
			} else if (stats.isFile()) {
				const prev = expected.get(childRel);
				if (prev === undefined || sha256(readFileSync(join(liveSkill, child))) !== prev) {
					drifted.push(childRel);
				}
				expected.delete(childRel);
			}
		}
	};
	walk(".");
	// Files the operator deleted mid-review also drift the tree.
	drifted.push(...expected.keys());
	return drifted.sort();
}

/** Publish one staged skill into the live catalog with a directory
 * swap: live → trash (staging area, same filesystem), staged → live,
 * trash deleted. A failed swap restores the original — the live catalog
 * is never left without the skill and never half-updated. Throws only
 * on mechanical filesystem failure (after rollback); drift is returned,
 * not thrown. */
function publishSkill(
	skillsDir: string,
	stagedDir: string,
	stagingArea: string,
	manifest: Map<string, string>,
	skill: string,
	reviewId: string,
): PublishOutcome {
	const drifted = liveDrifted(skillsDir, manifest, skill);
	if (drifted.length > 0) return { published: false, reason: "conflict", drifted };
	const liveSkill = join(skillsDir, skill);
	const existed = existsSync(liveSkill);
	const trash = join(stagingArea, `.replaced-${reviewId}-${skill}`);
	rmSync(trash, { recursive: true, force: true });
	if (existed) renameSync(liveSkill, trash);
	try {
		renameSync(join(stagedDir, skill), liveSkill);
	} catch (err) {
		if (existed) renameSync(trash, liveSkill);
		throw err;
	}
	rmSync(trash, { recursive: true, force: true });
	return { published: true };
}

// ---------- review run ----------

async function runReview(entry: QueueEntry, signal: AbortSignal): Promise<void> {
	const reviewDir = join(stagingRoot(entry.deps.workspaceDir), entry.reviewId);
	try {
		await runStagedReview(entry, signal, reviewDir);
	} finally {
		// Staging is single-use, including when the copy or model lookup fails.
		rmSync(reviewDir, { recursive: true, force: true });
	}
}

async function runStagedReview(entry: QueueEntry, signal: AbortSignal, reviewDir: string): Promise<void> {
	const { deps, turn, prior, trigger, reviewId } = entry;
	const conv = turn.conversationId;
	const stagingArea = stagingRoot(deps.workspaceDir);
	const stagedSkills = join(reviewDir, "skills");
	let manifest: Map<string, string>;
	try {
		manifest = copySkillsTree(deps.skillsDir, stagedSkills);
	} catch (err) {
		log.warn("reviewer review skipped — skills tree over staging budget", {
			review_id: reviewId,
			conversation: conv,
			error: (err as Error).message,
		});
		return;
	}
	// The catalog the model sees is the staged copy — exactly what its
	// writes apply to.
	const catalog = loadCatalog(stagedSkills);
	const catalogLines = catalog.entries.map((e) => `- ${e.name} — ${e.description}`);
	const { ref, model } = await deps.reviewModel(conv);
	log.info("reviewer review started", {
		review_id: reviewId,
		conversation: conv,
		seq: turn.turnSeq,
		trigger,
		model: ref,
		staged: reviewDir,
	});
	const timeoutController = new AbortController();
	const timer = setTimeout(() => timeoutController.abort(), REVIEW_TIMEOUT_MS);
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	timeoutController.signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted || timeoutController.signal.aborted) controller.abort();
	// The review's attribution set: every staging-relative path its
	// write tools actually wrote. Only these paths are candidates to
	// publish — concurrent edits in the LIVE tree are not its business.
	const written = new Set<string>();
	try {
		let result: Awaited<ReturnType<typeof generateText>>;
		try {
			result = await generateText({
				model,
				instructions: REVIEW_SYSTEM,
				prompt: reviewPrompt(turn, prior, catalogLines),
				tools: reviewTools(stagedSkills, written),
				stopWhen: isStepCount(REVIEW_MAX_STEPS),
				abortSignal: controller.signal,
			});
		} catch (err) {
			// Provider failure, the 5-minute abort, or a /stop abort:
			// staging is discarded and the live catalog was never touched.
			if (entry.cancelled) {
				log.info("reviewer review cancelled — staging discarded", {
					review_id: reviewId,
					conversation: conv,
				});
				return;
			}
			log.error("reviewer write discarded — model call failed", err, {
				review_id: reviewId,
				conversation: conv,
				written: [...written].sort(),
			});
			return;
		}
		// A model call is a cost line even backstage (the title-call rule).
		log.info("review model call", {
			review_id: reviewId,
			conversation: conv,
			model: ref,
			usage: {
				input: result.usage.inputTokens ?? null,
				cacheRead: result.usage.inputTokenDetails?.cacheReadTokens ?? null,
				cacheWrite: result.usage.inputTokenDetails?.cacheWriteTokens ?? null,
				output: result.usage.outputTokens ?? null,
			},
			steps: result.steps.length,
		});
		const { changed, bytes } = changedPaths(stagedSkills, manifest, written);
		// A /stop can land while validation or publishing would run —
		// nothing publishes from a cancelled review.
		if (entry.cancelled) {
			log.info("reviewer review cancelled — staging discarded", {
				review_id: reviewId,
				conversation: conv,
			});
			return;
		}
		if (changed.length === 0) {
			log.info("reviewer review done", {
				review_id: reviewId,
				conversation: conv,
				changed: false,
				skills: [],
				written: [...written].sort(),
			});
			return;
		}
		if (bytes > MAX_REVIEW_BYTES) {
			log.warn("reviewer write discarded — over the byte budget", {
				review_id: reviewId,
				conversation: conv,
				bytes,
				files: changed.length,
				written: [...written].sort(),
			});
			return;
		}
		// Every top-level dir among the review's changed paths is a skill
		// to validate — against the staged copy, before anything lands.
		const skills = [...new Set(changed.map((rel) => rel.split("/")[0]!))].sort();
		const validated: { skill: string; ok: boolean; output: string }[] = [];
		for (const skill of skills) {
			const outcome = await validateSkill(deps, reviewDir, skill);
			validated.push({ skill, ...outcome });
			log.info("reviewer validation", {
				review_id: reviewId,
				conversation: conv,
				skill,
				ok: outcome.ok,
				output: outcome.ok ? outcome.output.slice(0, 200) : outcome.output.slice(0, 500),
			});
		}
		const failures = validated.filter((v) => !v.ok);
		if (failures.length > 0) {
			log.warn("reviewer write rejected — skills-ref validate failed", {
				review_id: reviewId,
				conversation: conv,
				skills,
				failures: failures.map((f) => `${f.skill}: ${f.output.slice(0, 300)}`),
				staged: stagedSkills,
				written: [...written].sort(),
			});
			return;
		}
		// Validation passed: publish per skill, atomically, skipping any
		// skill the operator touched mid-review.
		const published: string[] = [];
		const skipped: { skill: string; drifted: string[] }[] = [];
		try {
			for (const skill of skills) {
				const outcome = publishSkill(deps.skillsDir, stagedSkills, stagingArea, manifest, skill, reviewId);
				if (outcome.published) published.push(skill);
				else skipped.push({ skill, drifted: outcome.drifted });
			}
		} catch (err) {
			log.error("reviewer publish failed — live catalog rolled back for the failing skill", err, {
				review_id: reviewId,
				conversation: conv,
				published,
				skipped,
				staged: stagedSkills,
			});
			throw err;
		}
		if (skipped.length > 0) {
			log.warn("reviewer publish skipped — live skills changed mid-review", {
				review_id: reviewId,
				conversation: conv,
				skipped,
				published,
			});
		}
		if (published.length === 0) return;
		// It publishes, then tells: history first (the durable record),
		// the topic note second. An undo request next turn deletes these dirs.
		const names = published.join(", ");
		deps.store.append(conv, [{
			id: randomUUID(),
			role: "system",
			parts: [{
				type: "text",
				text: `saved skill: ${names} — announced in this topic with an undo invite; ` +
					`an undo request means deleting ${published.map((s) => `skills/${s}/`).join(", ")}`,
			}],
		}]);
		try {
			await deps.notify(conv, published);
		} catch (err) {
			log.error("skill saved notice failed — history event already written", err, {
				review_id: reviewId,
				conversation: conv,
				skills: published,
			});
		}
		log.info("reviewer review done", {
			review_id: reviewId,
			conversation: conv,
			changed: true,
			skills: published,
			skipped,
			validated: validated.map((v) => ({ skill: v.skill, ok: v.ok })),
			written: [...written].sort(),
		});
	} finally {
		signal.removeEventListener("abort", onAbort);
		timeoutController.signal.removeEventListener("abort", onAbort);
		clearTimeout(timer);
	}
}
