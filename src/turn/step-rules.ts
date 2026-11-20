
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
	model: string;
	state: TurnState;
	signal: AbortSignal;
	contextWindow: number | undefined;
	priorInputTokens: number | null;
	filterRetryUsed: boolean;
	maxRetries: number | undefined;
	transientRetryDelayMs: number | undefined;
	overflowRecoverable: boolean;
	assertAuthority(): void;
	holdsAuthority(): boolean;
	preemptCheck?(info: { projectedInputTokens: number | null; stepNumber: number }): PreemptArm | null;
}

export interface StepRules {
	contextFill(): { used: number; limit: number } | null;
	beforeCall(stepNumber: number, messages: readonly PromptMessage[]): PreemptArm | null;
	afterCall(call: { inputTokens: number | null; failed: boolean }): void;
	callFailed(error: unknown, call: { step: number; midStream: boolean }): Promise<boolean>;
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
			if (init.preemptCheck === undefined || !init.overflowRecoverable || !init.holdsAuthority()) {
				return null;
			}
			const historyEstimate = estimateHistoryChars(messages);
			const projectedInputTokens =
				lastInput !== null && lastPrompt !== null
					? lastInput +
						Math.ceil(Math.max(0, historyEstimate - estimateHistoryChars(lastPrompt)) / 4)
					: null;
			const arm = init.preemptCheck({ projectedInputTokens, stepNumber });
			if (arm === null) return null;
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
			init.assertAuthority();
			const delayMs = init.transientRetryDelayMs ?? RETRY_INITIAL_DELAY_MS;
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
