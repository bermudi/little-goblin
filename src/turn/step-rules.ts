// The optional engine rules (design/runtime-turn.md → Engine rules) as
// shared code. The runtime opens one StepRules per attempt and hands it
// to the engine; the engine only reports its model-call boundaries.
// Policy, budgets and log lines live here, so a new engine gets every
// rule by calling the hooks its vendor loop can reach — never by
// copying turn logic.

import {
	isContentFilter,
	isTransientTurnFailure,
	ProviderContentFilterError,
} from "../agent/provider-errors.ts";
import { log } from "../log.ts";
import type { PromptMessage } from "../prompt-message.ts";
import { awaitRetryDelay, RETRY_INITIAL_DELAY_MS } from "../retry-delay.ts";
import { estimateHistoryChars } from "./itemize.ts";
import type { TurnState } from "./state.ts";

export type PreemptArm = "pressure";

export interface StepRulesInit {
	convId: string;
	epoch: number;
	/** The served model's config ref — log lines only. */
	model: string;
	state: TurnState;
	signal: AbortSignal;
	contextWindow: number | undefined;
	/** The last stored reply's input tokens: the fill before the first call. */
	priorInputTokens: number | null;
	/** The content-filter re-ask budget, carried across continuations. */
	filterRetryUsed: boolean;
	/** The lane's retry rule: 0 means every POST bills, so no transient re-dispatch. */
	maxRetries: number | undefined;
	/** Delay before a transient re-dispatch; absent = the SDK ladder's initial delay. */
	transientRetryDelayMs: number | undefined;
	/** One fold-resume per logical turn: false once the overflow rail is spent. */
	overflowRecoverable: boolean;
	assertAuthority(): void;
	holdsAuthority(): boolean;
	/**
	 * design/compaction.md → Timing. The runtime owns the thresholds and
	 * the compaction state; absent = pre-emption off.
	 */
	preemptCheck?(info: { projectedInputTokens: number | null; stepNumber: number }): PreemptArm | null;
}

export interface StepRules {
	/** contextFill: the window fill after the last completed model call. */
	contextFill(): { used: number; limit: number } | null;
	/**
	 * preemptFold: the boundary before a model call dispatches. An arm
	 * returned means the call must not dispatch — the engine stops the
	 * attempt with a PreemptSignal and the runtime folds and resumes.
	 */
	beforeCall(stepNumber: number, messages: readonly PromptMessage[]): PreemptArm | null;
	/** Every engine: a model call ended (`failed` = it ended on an error). */
	afterCall(call: { inputTokens: number | null; failed: boolean }): void;
	/**
	 * contentFilterReask + transientRetry: a model call failed. true =
	 * re-dispatch the same call. At most one re-dispatch per call.
	 * `midStream` = the failure came on the response stream; a failure
	 * before the stream opened is the transport middleware's to retry.
	 */
	callFailed(error: unknown, call: { step: number; midStream: boolean }): Promise<boolean>;
	/** The content-filter budget, for checkpoints and the outcome. */
	filterRetryUsed(): boolean;
}

export function openStepRules(init: StepRulesInit): StepRules {
	const { convId, epoch } = init;
	let fill: number | null = init.priorInputTokens;
	let filterRetryUsed = init.filterRetryUsed;
	let filterRetryPending = false;
	let transientRetries = 0;
	let transientRetryPending = false;
	let retryGrantedStep: number | null = null;
	// The projection basis: the last completed call's input tokens and
	// the prompt it went out with. A staged prompt whose call never
	// completed is never the basis.
	let lastInput: number | null = null;
	let staged: readonly PromptMessage[] | null = null;
	let lastPrompt: readonly PromptMessage[] | null = null;
	return {
		contextFill: () =>
			fill !== null && init.contextWindow !== undefined
				? { used: fill, limit: init.contextWindow }
				: null,
		beforeCall(stepNumber, messages) {
			staged = messages;
			// Gated on the overflow rail's budget (one fold-resume per
			// logical turn) and on live authority: a fenced turn takes the
			// fence path, not a fold.
			if (init.preemptCheck === undefined || !init.overflowRecoverable || !init.holdsAuthority()) {
				return null;
			}
			// The upcoming request, not the last one: the last completed
			// call's reported input plus everything appended since its
			// dispatch (assistant output, tool results, steers), at chars/4.
			// Null before the first completed call. Media is charged a fixed
			// cost (estimateHistoryChars), not its base64 length.
			const historyEstimate = estimateHistoryChars(messages);
			const projectedInputTokens =
				lastInput !== null && lastPrompt !== null
					? lastInput +
						Math.ceil(Math.max(0, historyEstimate - estimateHistoryChars(lastPrompt)) / 4)
					: null;
			const arm = init.preemptCheck({ projectedInputTokens, stepNumber });
			if (arm === null) return null;
			// A context landing issued at this same boundary never drives its
			// forced call — the pre-empt supersedes it, and the resume must
			// start unforced.
			init.state.retractContextLanding();
			log.warn("compaction pre-empt — folding at the step boundary", {
				conversation: convId,
				arm,
				step: stepNumber,
				projectedInputTokens,
				historyChars: historyEstimate,
			});
			return arm;
		},
		afterCall(call) {
			lastPrompt = staged;
			lastInput = call.inputTokens;
			fill = call.inputTokens;
			if (call.failed) return;
			if (filterRetryPending) {
				filterRetryPending = false;
				log.info("provider content filter retry recovered", { conversation: convId, epoch });
			}
			if (transientRetryPending) {
				transientRetryPending = false;
				log.info("transient stream retry recovered", {
					conversation: convId,
					epoch,
					retries: transientRetries,
				});
			}
		},
		async callFailed(error, call) {
			if (isContentFilter(error)) {
				init.assertAuthority();
				const blockedUsage =
					error instanceof ProviderContentFilterError ? (error.usage ?? null) : null;
				// The re-ask is deliberate even on a lane with no retry budget
				// (design/model.md → Provider-filter recovery).
				if (!filterRetryUsed && retryGrantedStep !== call.step) {
					filterRetryUsed = true;
					filterRetryPending = true;
					retryGrantedStep = call.step;
					log.warn("provider content filter — retrying unchanged model call once", error, {
						conversation: convId,
						epoch,
						model: init.model,
						blockedUsage,
					});
					return true;
				}
				log.warn("provider content filter — retry budget exhausted", error, {
					conversation: convId,
					epoch,
					blockedUsage,
				});
				return false;
			}
			if (!call.midStream || !isTransientTurnFailure(error)) return false;
			// A transient transport failure (socket reset mid-stream) on one
			// model call: the call re-dispatches, earlier calls and their tool
			// results stay.
			init.assertAuthority();
			const delayMs = init.transientRetryDelayMs ?? RETRY_INITIAL_DELAY_MS;
			// Sleep only when a retry will be granted — the budget-spent and
			// aborted paths must not pay the delay.
			if (!init.signal.aborted && init.maxRetries !== 0 && retryGrantedStep !== call.step) {
				await awaitRetryDelay(delayMs, init.signal);
				if (!init.signal.aborted) {
					retryGrantedStep = call.step;
					transientRetries++;
					transientRetryPending = true;
					log.warn("transient model stream error — retrying the failed model step", error, {
						conversation: convId,
						epoch,
						model: init.model,
						attempt: transientRetries,
						delayMs,
					});
					return true;
				}
			}
			// An aborted turn takes the fence path — one story, not two.
			if (!init.signal.aborted) {
				log.warn(
					init.maxRetries === 0
						? "transient model stream error — lane carries no retry budget (every POST bills)"
						: "transient model stream error — step retry budget spent",
					error,
					{ conversation: convId, epoch, model: init.model, attempt: transientRetries },
				);
			}
			return false;
		},
		filterRetryUsed: () => filterRetryUsed,
	};
}
