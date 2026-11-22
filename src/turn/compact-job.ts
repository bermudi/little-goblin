import { type CompactionOutcome, type Flush, runCompaction } from "../agent/compaction.ts";
import type { PrefixSummarizer } from "../agent/compaction.ts";
import type { Conversation } from "../conversation-read.ts";
import type { ConversationStore } from "../conversation.ts";
import { log } from "../log.ts";
import type { makePrefixFlush, PrefixStep } from "./prefix-summary.ts";
import type { ClaudeStep } from "../agent/claude-code/mod.ts";
import type { MemoryTurnDeps } from "../memory/mod.ts";

export interface CompactionSeam {
	modelRef(conv: Conversation): string;
	contextWindow(conv: Conversation): number | null | Promise<number | null>;
	summarize(
		conv: Conversation,
		system: string,
		prompt: string,
		signal: AbortSignal,
		modelRef: string,
	): Promise<string>;
	flush?(conv: Conversation, modelRef: string): Flush | null;
	prefixFlush?(
		input: {
			conv: Conversation;
			modelRef: string;
			step: PrefixStep;
			tools: Parameters<typeof makePrefixFlush>[0]["tools"];
			hydratedModelOutputTools?: readonly string[];
			memory?: MemoryTurnDeps;
			foldCeiling(): number | null;
			assertAuthority(): void;
		},
	): PrefixSummarizer["flush"] | null;
	prefixStep?(conv: Conversation, modelRef: string): Promise<PrefixStep | null>;
	claudePrefixStep?(conv: Conversation, modelRef: string): ClaudeStep | null;
	nativeCompact?(conv: Conversation, modelRef: string, signal: AbortSignal): Promise<unknown>;
}
export interface CompactJobDeps {
	store: ConversationStore;
	compaction?: CompactionSeam | undefined;
	captureConversation?: ((conv: Conversation) => Conversation) | undefined;
	budgets(contextWindow: number | null): { tailTokenBudget: number; inputTokenBudget: number };
	checkAuthority(convId: string, epoch: number): void;
	foldCeiling(convId: string, activeFloor?: number): number | null;
	makePrefix?(
		conv: Conversation,
		modelRef: string,
		signal: AbortSignal,
		foldedThroughSeq: number,
	): Promise<PrefixSummarizer | null>;
	holdController(controller: AbortController): void;
	releaseController(controller: AbortController): void;
}

export async function runCompactJob(
	conv: Conversation,
	reason: "threshold" | "manual" | "idle" | "overflow" | "preempt",
	activeFloor: number | undefined,
	focus: string | undefined,
	deps: CompactJobDeps,
	serving?: Conversation,
): Promise<CompactionOutcome> {
	if (reason === "manual" || reason === "idle") {
		conv = deps.store.get(conv.id) ?? conv;
		conv = deps.captureConversation?.(conv) ?? conv;
	}
	const compaction = deps.compaction;
	if (!compaction) return { kind: "noop", reason: "compaction not configured" };
	const epoch = conv.epoch;
	const controller = new AbortController();
	deps.holdController(controller);
	try {
		const contextWindow = await compaction.contextWindow(conv);
		const servingWindow =
			serving !== undefined && serving.model !== conv.model ? await compaction.contextWindow(serving) : null;
		deps.checkAuthority(conv.id, epoch);
		const { inputTokenBudget } = deps.budgets(contextWindow);
		const { tailTokenBudget } = deps.budgets(smallerWindow(contextWindow, servingWindow));
		const tail = reason === "overflow" ? Math.floor(tailTokenBudget / 2) : tailTokenBudget;
		const modelRef = compaction.modelRef(conv);
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
			modelRef,
			(system, prompt, signal, model) => compaction.summarize(conv, system, prompt, signal, model),
			{
				tailTokenBudget: tail,
				inputTokenBudget,
				reason,
				...(focus !== undefined ? { focus } : {}),
				...(deps.makePrefix !== undefined
					? {
							prefix: (foldedThroughSeq: number) =>
								deps.makePrefix!(conv, modelRef, controller.signal, foldedThroughSeq),
						}
					: {}),
				beforeSeq: () => deps.foldCeiling(conv.id, activeFloor),
				assertAuthority: () => deps.checkAuthority(conv.id, epoch),
				...(flush !== null ? { flush } : {}),
			},
			controller.signal,
		);
		if (outcome.kind === "compacted") {
			deps.store.clearPromptSnapshot(conv.id);
			log.info("prompt snapshot cleared for rebuild", {
				conversation: conv.id,
				reason,
			});
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

function smallerWindow(a: number | null, b: number | null): number | null {
	if (a === null) return b;
	if (b === null) return a;
	return Math.min(a, b);
}
