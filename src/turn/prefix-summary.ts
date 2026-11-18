import { generateText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { MediaPosition } from "../agent/attachments.ts";
import type { PrefixSummarizer } from "../agent/compaction.ts";
import type { Conversation } from "../conversation-read.ts";
import type { ConversationStore } from "../conversation.ts";
import type { MemoryTurnDeps } from "../memory/mod.ts";
import type { Message } from "../message.ts";
import { buildModelView, type ViewContext } from "./view.ts";
import { resolveSkillRef } from "../agent/skill-inject.ts";

export interface PrefixStep {
	modelRef: string;
	model: LanguageModel;
	system: string;
	providerOptions?: ProviderOptions;
	maxRetries?: number;
	inputModalities: Set<string> | undefined;
	carries(mediaType: string, position: MediaPosition): boolean;
	keepProviderExecuted: boolean;
}

export function makePrefixSummarizer(input: {
	conv: Conversation;
	step: PrefixStep;
	store: ConversationStore;
	tools: ToolSet;
	memory?: MemoryTurnDeps;
	foldCeiling(): number | null;
	assertAuthority(): void;
}): PrefixSummarizer {
	const { conv, step, store, tools } = input;
	const view: ViewContext = {
		convId: conv.id,
		modelRef: step.modelRef,
		tools: {},
		sdkTools: tools,
		modalities: step.inputModalities,
		carries: step.carries,
		keepProviderExecuted: step.keepProviderExecuted,
		skillRef: resolveSkillRef,
	};
	const prior =
		input.memory === undefined || conv.memoryExcluded
			? []
			: input.memory.contexts.load(conv.id);
	return {
		modelRef: step.modelRef,
		async call(turns, signal, cut) {
			input.assertAuthority();
			const ceiling = input.foldCeiling();
			let entries = store.modelEntries(conv.id).filter(
				(e) => ceiling === null || e.seq < ceiling,
			);
			let partial: Message | null = null;
			if (cut !== undefined) {
				const cutEntry = entries.find((entry) => entry.seq === cut.seq);
				if (cutEntry === undefined) {
					throw new Error(`split prefix event ${cut.seq} is missing from the model view`);
				}
				if (!Number.isInteger(cut.part) || cut.part < 0 || cut.part > cutEntry.message.parts.length) {
					throw new Error(`split prefix part ${cut.part} is outside event ${cut.seq}`);
				}
				entries = entries.filter((entry) => entry.seq < cut.seq);
				partial = { ...cutEntry.message, parts: cutEntry.message.parts.slice(0, cut.part) };
			}
			const messages = await buildModelView(view, {
				entries,
				prior,
				current: null,
				partial,
				summarySeq: store.memoryEligibility(conv.id).summarySeq,
				ownedSeqs: [],
				assertAuthority: input.assertAuthority,
			});
			const sdkTools = tools;
			const requestMessages: ModelMessage[] = [
				...messages,
				...turns.map((turn) => ({ role: turn.role, content: turn.text } as ModelMessage)),
			];
			const { text } = await generateText({
				model: step.model,
				instructions: step.system,
				tools: sdkTools,
				messages: requestMessages,
				...(step.providerOptions !== undefined ? { providerOptions: step.providerOptions } : {}),
				...(step.maxRetries !== undefined ? { maxRetries: step.maxRetries } : {}),
				abortSignal: signal,
			});
			return text;
		},
	};
}
