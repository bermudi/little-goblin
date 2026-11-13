// Skill reviewer — automatic skill saving.
//
// Every completed turn is gated by System One (a typed-decision model):
// either question at/past its threshold triggers a background review.
// Any gate failure falls back to the 8+ tool-call rule. Every gate logs
// probabilities, thresholds, trigger, tool names, fallback streak,
// decision, tokens, cost, latency — the experiment must answer cost, hit
// rate, and outage drift from the log alone.
//
// The review works in a private staging copy of the skills tree
// (workspace/.reviewer-staging/<id>/skills), confined by lexical AND
// realpath checks, no shell. Validated writes are PROPOSED — swapped
// atomically into skills-proposed/<name>/ — never installed: the live
// catalog changes only on operator approval (ruling 2026-10-10). A skill
// whose live copy changed mid-review is skipped, never proposed from a
// stale base. A later skill's failed swap cannot undo earlier proposals.
//
// Reviews queue in turn-completion order, capped, serialized.
// /stop cancels queued reviews and aborts the in-flight one.
// Memory-excluded conversations never gate — off the record means no
// durable distillation. Fire-and-forget: a missed save on a racing
// shutdown is benign and logged. One instance owns queue, in-flight
// slot, pending gates, fallback streak — no module-level state.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { generateText, isStepCount, type LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { loadCatalog } from "./agent/skills.ts";
import type { ConversationStore } from "./conversation.ts";
import {
	type CompletedTurn,
	type EvidenceLimits,
	type PriorTurnContext,
	type ToolCallDigest,
} from "./reviewer-evidence.ts";
import {
	buildGateState,
	FALLBACK_TOOL_CALLS,
	GATE_QUESTIONS,
	MAX_OPERATOR_CHARS,
	MAX_REPLY_CHARS,
} from "./reviewer-gate.ts";
import { proposeSkill } from "./reviewer-propose.ts";
import {
	changedPaths,
	copySkillsTree,
	reviewTools,
	stagingRoot,
	StagingBudgetError,
	validateSkill,
} from "./reviewer-staging.ts";
import { System1Client, System1Error } from "./system1.ts";
import { log } from "./log.ts";

export type Trigger = "correction" | "procedure";

export interface ReviewerDeps {
	gate: Pick<System1Client, "decide">;
	thresholds: { correction: number; procedure: number };
	// Queued (not running) review cap; a full queue drops the incoming.
	queueCap: number;
	evidence: EvidenceLimits;
	// Resolves the review model fresh per review (the mini app owns the
	// default between reviews; the override is config). Labels the call
	// for the model-call wrapper.
	reviewModel(conversationId: string): Promise<{
		ref: string;
		model: LanguageModel;
		// Provider retry rule for the review call — 0 on 1min, absent
		// keeps the SDK default.
		maxRetries?: number;
		// Wire options the review call must carry for its provider — the
		// 1min review route, where tools demand reasoning_effort on the
		// GPT-5.6/6-Sol/6-Luna ids. Absent sends none (today's behavior
		// on every other route).
		providerOptions?: ProviderOptions;
	}>;
	store: Pick<ConversationStore, "append">;
	skillsDir: string;
	// Where validated proposals park (workspace/skills-proposed) — the
	// live catalog in skillsDir is read-only to the reviewer.
	proposedDir: string;
	workspaceDir: string;
	// Posts the proposal note after history and provenance are durable.
	// Delivery failures propagate without undoing those writes.
	notify(conversationId: string, skills: string[]): Promise<void>;
	// Provenance rows for every successfully proposed skill, written
	// before notification can yield. Recorder failures propagate without
	// undoing the proposal.
	recordSources?(conversationId: string, reviewId: string, skills: string[]): void;
	// Test door — the production path always uses `skills-ref`.
	skillsRefBin?: string;
}

// ---------- review queue ----------
//
// One at a time, in turn-completion order. Pending gate decisions hold
// later reviews back — overlapping runs would propose over each other's
// announced writes. A full queue drops the incoming review (the newest
// turn is the most re-gateable) and logs it.

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

interface PendingGate {
	conversationId: string;
	seq: number;
	cancelled: boolean;
}

// ---------- the reviewer instance ----------

export class Reviewer {
	// Shared across every conversation this instance gates — an outage is
	// an outage regardless of which conversation noticed.
	private fallbackStreak = 0;
	private readonly reviewQueue: QueueEntry[] = [];
	private inFlight: { entry: QueueEntry; controller: AbortController } | null = null;
	private readonly pendingGates = new Set<PendingGate>();
	private cancellingAll = false;

	constructor(private readonly deps: ReviewerDeps) {}

	get evidence(): EvidenceLimits {
		return this.deps.evidence;
	}

	async considerTurn(turn: CompletedTurn, priorTurn?: PriorTurnContext): Promise<void> {
		// Register before the first await: /stop and shutdown must see a gate
		// even when no queue entry exists yet.
		const pending = { conversationId: turn.conversationId, seq: turn.turnSeq, cancelled: false };
		this.pendingGates.add(pending);
		const started = Date.now();
		const state = buildGateState(turn);
		// Bounded — the gate line must explain what kind of turn scored
		// what without a second lookup.
		const toolNames = [...new Set(turn.toolNames)].slice(0, 16);
		try {
			const decision = await this.deps.gate.decide(state, GATE_QUESTIONS);
			this.fallbackStreak = 0;
			const correction = decision.answers["correction"] ?? 0;
			const procedure = decision.answers["procedure"] ?? 0;
			const corrHit = correction >= this.deps.thresholds.correction;
			const procHit = procedure >= this.deps.thresholds.procedure;
			const review = corrHit || procHit;
			// When both questions fire, correction wins the trigger.
			const trigger: Trigger = corrHit ? "correction" : "procedure";
			const reviewId = review ? randomUUID() : null;
			// The experiment line.
			log.info("reviewer gate", {
				conversation: turn.conversationId,
				correction,
				procedure,
				thresholds: {
					correction: this.deps.thresholds.correction,
					procedure: this.deps.thresholds.procedure,
				},
				review,
				trigger: review ? trigger : null,
				review_id: reviewId,
				fallback: false,
				fallbackStreak: this.fallbackStreak,
				tools: toolNames,
				toolCalls: turn.toolNames.length,
				inputTokens: decision.inputTokens,
				cost: decision.cost,
				ms: Date.now() - started,
			});
			if (review && !pending.cancelled)
				return this.enqueueReview(
					turn,
					trigger === "correction" ? priorTurn : undefined,
					trigger,
					reviewId!,
				);
		} catch (err) {
			// Only the gate's own failures fall back — anything else is a
			// bug and propagates to the runtime's backstop, loud.
			if (!(err instanceof System1Error)) throw err;
			this.fallbackStreak += 1;
			const review = turn.toolNames.length >= FALLBACK_TOOL_CALLS;
			const trigger: Trigger = "procedure";
			const reviewId = review ? randomUUID() : null;
			log.info("reviewer gate", {
				conversation: turn.conversationId,
				correction: null,
				procedure: null,
				thresholds: {
					correction: this.deps.thresholds.correction,
					procedure: this.deps.thresholds.procedure,
				},
				review,
				trigger: review ? trigger : null,
				review_id: reviewId,
				fallback: true,
				fallbackStreak: this.fallbackStreak,
				reason: err.message,
				tools: toolNames,
				toolCalls: turn.toolNames.length,
				inputTokens: null,
				cost: null,
				ms: Date.now() - started,
			});
			if (review && !pending.cancelled)
				return this.enqueueReview(turn, undefined, trigger, reviewId!);
		} finally {
			this.pendingGates.delete(pending);
			if (pending.cancelled)
				log.info("reviewer gate cancelled — no review enqueued", {
					conversation: turn.conversationId,
					seq: turn.turnSeq,
				});
			this.drainQueue();
		}
	}

	// /stop: cancel a conversation's pending gates and reviews; the
	// in-flight one's staging is discarded by the normal failure path.
	cancelReviews(conversationId: string): number {
		let n = 0;
		for (const gate of this.pendingGates) {
			if (gate.conversationId !== conversationId || gate.cancelled) continue;
			gate.cancelled = true;
			this.pendingGates.delete(gate);
			log.info("reviewer gate cancelled — pending decision", {
				conversation: conversationId,
				seq: gate.seq,
			});
			n += 1;
		}
		for (const entry of [...this.reviewQueue]) {
			if (entry.conversationId !== conversationId || entry.cancelled) continue;
			entry.cancelled = true;
			this.reviewQueue.splice(this.reviewQueue.indexOf(entry), 1);
			entry.done.resolve();
			log.info("reviewer review cancelled — dropped from queue", {
				review_id: entry.reviewId,
				conversation: conversationId,
				seq: entry.seq,
			});
			n += 1;
		}
		if (
			this.inFlight !== null &&
			this.inFlight.entry.conversationId === conversationId &&
			!this.inFlight.entry.cancelled
		) {
			this.inFlight.entry.cancelled = true;
			this.inFlight.controller.abort();
			log.info("reviewer review cancelled — aborting in-flight", {
				review_id: this.inFlight.entry.reviewId,
				conversation: conversationId,
				seq: this.inFlight.entry.seq,
			});
			n += 1;
		}
		this.drainQueue();
		return n;
	}

	// Shutdown fences reviewer work even when the originating lane has drained.
	cancelAllReviews(): number {
		const conversations = new Set([
			...[...this.pendingGates].map((g) => g.conversationId),
			...this.reviewQueue.map((e) => e.conversationId),
			...(this.inFlight ? [this.inFlight.entry.conversationId] : []),
		]);
		let cancelled = 0;
		this.cancellingAll = true;
		try {
			for (const convId of conversations) cancelled += this.cancelReviews(convId);
		} finally {
			this.cancellingAll = false;
		}
		return cancelled;
	}

	private enqueueReview(
		turn: CompletedTurn,
		prior: PriorTurnContext | undefined,
		trigger: Trigger,
		reviewId: string,
	): Promise<void> {
		if (this.reviewQueue.length >= this.deps.queueCap) {
			log.warn("reviewer queue full — review dropped", {
				review_id: reviewId,
				conversation: turn.conversationId,
				seq: turn.turnSeq,
				queued: this.reviewQueue.length,
				cap: this.deps.queueCap,
			});
			return Promise.resolve();
		}
		const entry: QueueEntry = {
			seq: turn.turnSeq,
			reviewId,
			conversationId: turn.conversationId,
			deps: this.deps,
			turn,
			prior,
			trigger,
			cancelled: false,
			done: deferred<void>(),
		};
		// Insert in completion order — gates resolve out of order whenever
		// two conversations complete close together.
		const idx = this.reviewQueue.findIndex((e) => e.seq > entry.seq);
		this.reviewQueue.splice(idx === -1 ? this.reviewQueue.length : idx, 0, entry);
		this.drainQueue();
		// The caller resolves only when ITS OWN review settles (or is
		// dropped/cancelled — policy outcomes, not errors).
		return entry.done.promise;
	}

	private drainQueue(): void {
		if (this.cancellingAll || this.inFlight !== null || this.reviewQueue.length === 0) return;
		const entry = this.reviewQueue[0]!;
		// A later gate cannot overtake an earlier completion, including a
		// no-review decision that has not arrived yet.
		if ([...this.pendingGates].some((g) => g.seq < entry.seq)) return;
		this.reviewQueue.shift();
		const controller = new AbortController();
		this.inFlight = { entry, controller };
		void runReview(entry, controller.signal)
			.catch((err: unknown) => {
				// A thrown review is a bug (staging setup, propose mechanics)
				// — it propagates to the runtime's backstop, loud, without
				// poisoning the next queued review.
				entry.done.reject(err);
			})
			.finally(() => {
				this.inFlight = null;
				entry.done.resolve();
				this.drainQueue();
			});
	}
}
// ---------- review ----------

// A review is a bounded background call, not a turn: ten steps against
// three file tools, five minutes wall-clock, then it aborts and its
// staging is discarded like any other failure.
const REVIEW_MAX_STEPS = 10;
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
// Evidence, not full context — the digest and prior-turn blocks carry
// their own budgets, so the worst-case prompt stays ~30k chars.
const MAX_REVIEW_TRANSCRIPT_CHARS = 12_000;
// The prior (corrected) turn gets smaller budgets — when space is tight
// the correction, the wrong turn, and the current answer win.
const PRIOR_MAX_OPERATOR_CHARS = 4_000;
const PRIOR_MAX_REPLY_CHARS = 6_000;
// A runaway review writes big — over this the write is discarded
// unvalidated.
const MAX_REVIEW_BYTES = 100 * 1024;
const REVIEW_SYSTEM =
	"You are goblin's skill reviewer. A just-completed turn looked worth distilling into a skill. " +
	"Your working directory IS the skills catalog (a private copy — your writes reach the operator only after they validate): " +
	"read `<name>/SKILL.md` to inspect a skill, " +
	"write `<name>/SKILL.md` (plus any helper files the skill needs) to create or replace one. " +
	"The turn's evidence includes each tool call's truncated arguments and result — a failed call is marked FAILED. " +
	"On a correction, the block 'the turn this correction refers back to' shows what went wrong the first time. " +
	"Decide, then act:\n" +
	"- Create ONE skill when the turn taught a repeatable multi-step procedure no skill covers.\n" +
	"- Edit ONE skill when an existing skill is wrong or incomplete about what the turn showed.\n" +
	"- Never propose a wrapper for machinery that already exists: the turn's built-in tools are listed with it — " +
	"a procedure one of them performs (or one config line would enable) is not a skill.\n" +
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
	const transcript =
		`operator:\n${operator}\n\nassistant reply:\n${turn.replyText.slice(0, MAX_REPLY_CHARS)}`.slice(
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
		"",
		"Built-in tools the turn could call (a procedure one of these performs is not a skill):",
		"",
		...(turn.toolInventory.length === 0
			? ["(none recorded)"]
			: turn.toolInventory.map(
					(t) => `- ${t.name}${t.description === "" ? "" : ` — ${t.description}`}`,
				)),
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

async function runStagedReview(
	entry: QueueEntry,
	signal: AbortSignal,
	reviewDir: string,
): Promise<void> {
	const { deps, turn, prior, trigger, reviewId } = entry;
	const conv = turn.conversationId;
	const stagingArea = stagingRoot(deps.workspaceDir);
	const stagedSkills = join(reviewDir, "skills");
	let manifest: Map<string, string>;
	try {
		manifest = copySkillsTree(deps.skillsDir, stagedSkills);
	} catch (err) {
		// Policy (the budget) and mechanical failure (permissions, disk)
		// carry different labels — one message would lie about the other.
		if (err instanceof StagingBudgetError) {
			log.warn("reviewer review skipped — skills tree over staging budget", err, {
				review_id: reviewId,
				conversation: conv,
			});
		} else {
			log.error("reviewer review skipped — skills tree copy failed", err, {
				review_id: reviewId,
				conversation: conv,
			});
		}
		return;
	}
	// The catalog the model sees is the staged copy — exactly what its
	// writes apply to.
	const catalog = loadCatalog(stagedSkills);
	const catalogLines = catalog.entries.map((e) => `- ${e.name} — ${e.description}`);
	let ref: string;
	let model: LanguageModel;
	let reviewMaxRetries: number | undefined;
	let reviewProviderOptions: ProviderOptions | undefined;
	try {
		({
			ref,
			model,
			maxRetries: reviewMaxRetries,
			providerOptions: reviewProviderOptions,
		} = await deps.reviewModel(conv));
	} catch (err) {
		// Model resolve/auth failure gets the same containment as a
		// model-call failure: a line carrying the review id, staging
		// discarded by runReview's finally, nothing live touched.
		log.error("reviewer write discarded — review model resolution failed", err, {
			review_id: reviewId,
			conversation: conv,
		});
		return;
	}
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
	// propose — concurrent edits in the LIVE tree are not its business.
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
				...(reviewMaxRetries !== undefined ? { maxRetries: reviewMaxRetries } : {}),
				...(reviewProviderOptions !== undefined ? { providerOptions: reviewProviderOptions } : {}),
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
		// A /stop can land while validation or proposing would run —
		// nothing is proposed from a cancelled review.
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
			// Validation is asynchronous: /stop can arrive while the
			// validator runs. Never start another validator or propose then.
			if (entry.cancelled) {
				log.info("reviewer review cancelled — staging discarded", {
					review_id: reviewId,
					conversation: conv,
				});
				return;
			}
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
		// Validation passed: propose per skill, atomically, skipping any
		// skill the operator touched mid-review. Nothing installs — the
		// live catalog changes only when the operator approves.
		const proposedNames: string[] = [];
		const skipped: { skill: string; drifted: string[] }[] = [];
		let proposeError: unknown = null;
		try {
			for (const skill of skills) {
				const outcome = proposeSkill(
					deps.skillsDir,
					deps.proposedDir,
					stagedSkills,
					stagingArea,
					manifest,
					skill,
					reviewId,
				);
				if (outcome.proposed) proposedNames.push(skill);
				else skipped.push({ skill, drifted: outcome.drifted });
			}
		} catch (err) {
			log.error(
				"reviewer proposal failed — failing proposal rolled back, earlier proposals stand",
				err,
				{
					review_id: reviewId,
					conversation: conv,
					proposed: proposedNames,
					skipped,
					staged: stagedSkills,
				},
			);
			proposeError = err;
		}
		if (skipped.length > 0) {
			log.warn("reviewer proposal skipped — live state conflicts", {
				review_id: reviewId,
				conversation: conv,
				skipped,
				proposed: proposedNames,
			});
		}
		if (proposedNames.length === 0) {
			if (proposeError !== null) throw proposeError;
			return;
		}
		// Attribute the durable write before notification can yield to a
		// later turn editing the same skill.
		deps.recordSources?.(conv, reviewId, proposedNames);
		// It proposes, then tells: history first (the durable record),
		// the topic note second. An approval next turn moves these dirs
		// into skills/; a discard deletes them.
		const names = proposedNames.join(", ");
		deps.store.append(conv, [
			{
				id: randomUUID(),
				role: "system",
				parts: [
					{
						type: "text",
						text:
							`proposed skill: ${names} — parked in ${proposedNames.map((s) => `skills-proposed/${s}/`).join(", ")}, not installed; ` +
							`an operator approval means moving it into skills/ (replacing any live copy), ` +
							`a discard means deleting the proposal`,
					},
				],
			},
		]);
		// Backfill uses this timestamp as write evidence, not delivery time.
		log.info(
			proposeError === null ? "reviewer review done" : "reviewer review partially proposed",
			{
				review_id: reviewId,
				conversation: conv,
				changed: true,
				skills: proposedNames,
				skipped,
				validated: validated.map((v) => ({ skill: v.skill, ok: v.ok })),
				written: [...written].sort(),
			},
		);
		await deps.notify(conv, proposedNames);
		// A later skill's failed swap does not undo earlier proposals.
		// Record and announce those durable changes before surfacing the
		// failure to the review runner.
		if (proposeError !== null) throw proposeError;
	} finally {
		signal.removeEventListener("abort", onAbort);
		timeoutController.signal.removeEventListener("abort", onAbort);
		clearTimeout(timer);
	}
}
