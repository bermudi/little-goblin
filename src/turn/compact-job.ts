// A queued compaction job: window lookup, budgets, the summary walk, and the prompt-snapshot rebuild — the runtime injects store, authority, and lane cancellation.

import { type CompactionOutcome, type Flush, runCompaction } from "../agent/compaction.ts";
import { candidateRefs } from "../agent/model-fallback.ts";
import type { Conversation, ConversationStore } from "../conversation.ts";
import { log } from "../log.ts";

// Optional compaction summarizes on the conversation's model, then walks
// `modelFallbacks` (runCompaction owns the walk; `summarize` runs one
// call on the ref it is handed). Its dedicated signal lets /stop and
// shutdown cancel an in-flight summary. A failed summary leaves the
// event stream and compaction pointer untouched.
export interface CompactionSeam {
	modelRef(conv: Conversation): string;
	// Catalog window lookup — metadata only, never a model step: no auth
	// resolution and no prompt build, so a compaction pass can never mint
	// or rewrite the frozen prompt snapshot. Null means unknown; budgets
	// fall back to the defaults.
	contextWindow(conv: Conversation): number | null | Promise<number | null>;
	summarize(
		conv: Conversation,
		system: string,
		prompt: string,
		signal: AbortSignal,
		modelRef: string,
	): Promise<string>;
	// design/compaction.md → Memory flush. Null when this conversation must
	// not flush (memory configured, memory-excluded, no tool-capable engine).
	flush?(conv: Conversation, modelRef: string): Flush | null;
	// #418: the recorded native Claude session compacts itself alongside
	// the goblin fold. Runs only when the fold actually compacts; a
	// failure is logged and never fails the job.
	nativeCompact?(conv: Conversation, modelRef: string, signal: AbortSignal): Promise<unknown>;
}

export interface CompactJobDeps {
	store: ConversationStore;
	compaction?: CompactionSeam | undefined;
	// Capture channel settings so the job summarizes on a stable snapshot.
	captureConversation?: ((conv: Conversation) => Conversation) | undefined;
	modelFallbacks?: (() => readonly string[]) | undefined;
	// design/compaction.md → Budgets, as a pure function of the window.
	budgets(contextWindow: number | null): { tailTokenBudget: number; inputTokenBudget: number };
	checkAuthority(convId: string, epoch: number): void;
	// Where completed history ends for a fold, evaluated at history-read time.
	foldCeiling(convId: string, activeFloor?: number): number | null;
	// Lane-owned cancellation: registered before the first await so /stop
	// can cancel a pending contextWindow lookup; released only while still
	// the registered controller.
	holdController(controller: AbortController): void;
	releaseController(controller: AbortController): void;
}

// Compaction summarizes the event delta without rewriting the event stream.
// Its dedicated controller handles stop/shutdown; authority checks leave the
// pointer and prompt snapshot unchanged on cancellation or fencing. The
// caller decides whether a failure is reported or retried. activeFloor,
// when given, is the running turn's earliest member seq — the fold stays
// strictly below it (and below any still-queued input; foldCeiling).
export async function runCompactJob(
	conv: Conversation,
	reason: "threshold" | "manual" | "overflow" | "preempt",
	activeFloor: number | undefined,
	deps: CompactJobDeps,
): Promise<CompactionOutcome> {
	if (reason === "manual") {
		conv = deps.store.get(conv.id) ?? conv;
		conv = deps.captureConversation?.(conv) ?? conv;
	}
	const compaction = deps.compaction;
	if (!compaction) return { kind: "noop", reason: "compaction not configured" };
	// Threshold/overflow use the admitted epoch; manual jobs resolve a fresh
	// conversation before taking authority.
	const epoch = conv.epoch;
	// Register before the first await so /stop can cancel a pending
	// contextWindow lookup.
	const controller = new AbortController();
	deps.holdController(controller);
	try {
		// Metadata only — never buildStep: resolving a model and building
		// a system prompt here would freeze a snapshot no turn asked for.
		const contextWindow = await compaction.contextWindow(conv);
		// The authority check doubles as the abort check: compactController
		// is only aborted by cancelFenced after the epoch commits, so a
		// /stop during the lookup already reports as a fence. runCompaction
		// reverses the order after each call — a provider may resolve under
		// abort, so there the signal check must land first.
		deps.checkAuthority(conv.id, epoch);
		const { tailTokenBudget, inputTokenBudget } = deps.budgets(contextWindow);
		// Overflow recovery uses a smaller tail to stay below the provider's
		// observed limit. A pre-empt folds before any failure — full tail.
		const tail = reason === "overflow" ? Math.floor(tailTokenBudget / 2) : tailTokenBudget;
		const modelRef = compaction.modelRef(conv);
		// Overflow recovery runs mid-turn behind a provider error: an extra
		// call there only delays the answer (operator, 2026-11-09).
		// The gate reads exclusion fresh: setMeta does not bump the epoch, so
		// a queued job's snapshot can miss an exclusion made while it waited.
		const flush =
			reason === "overflow"
				? null
				: (compaction.flush?.(deps.store.get(conv.id) ?? conv, modelRef) ?? null);
		log.info("compaction window", {
			conversation: conv.id,
			model: modelRef,
			contextWindow,
			tailTokenBudget: tail,
			inputTokenBudget,
			reason,
			flush: flush !== null,
		});
		const outcome = await runCompaction(
			conv.id,
			deps.store,
			candidateRefs(modelRef, deps.modelFallbacks?.() ?? []),
			(system, prompt, signal, model) => compaction.summarize(conv, system, prompt, signal, model),
			{
				tailTokenBudget: tail,
				inputTokenBudget,
				reason,
				// Evaluated at history-read time: work may have queued while
				// the contextWindow lookup awaited.
				beforeSeq: () => deps.foldCeiling(conv.id, activeFloor),
				assertAuthority: () => deps.checkAuthority(conv.id, epoch),
				...(flush !== null ? { flush } : {}),
			},
			controller.signal,
		);
		if (outcome.kind === "compacted") {
			// Rebuild the frozen prompt after compaction changed history.
			deps.store.clearPromptSnapshot(conv.id);
			log.info("prompt snapshot cleared for rebuild", {
				conversation: conv.id,
				reason,
			});
			// #418: Claude compacts its own session next to the fold —
			// best-effort; the engine drops a failed session's record so
			// the next turn starts fresh from the folded view.
			if (compaction.nativeCompact !== undefined) {
				try {
					await compaction.nativeCompact(conv, modelRef, controller.signal);
				} catch (err) {
					log.warn("claude native compaction failed — goblin fold unaffected", err, {
						conversation: conv.id,
						model: modelRef,
					});
				}
			}
		}
		return outcome;
	} finally {
		deps.releaseController(controller);
	}
}
