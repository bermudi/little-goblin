import { generateText, type ModelMessage, type ToolSet } from "ai";
import type { PrefixSummarizer } from "../agent/compaction.ts";
import type { Conversation } from "../conversation-read.ts";
import type { ConversationStore } from "../conversation.ts";
import type { MemoryTurnDeps } from "../memory/mod.ts";
import { toToolSet } from "./ai-sdk-tools.ts";
import { buildModelView, type ViewContext } from "./view.ts";
import type { Tools } from "../tool.ts";
import type { PrefixStep } from "../agent/step.ts";
import { resolveSkillRef } from "../agent/skill-inject.ts";

export function makePrefixSummarizer(input: {
	conv: Conversation;
	step: PrefixStep;
	store: ConversationStore;
	tools: Tools;
	memory?: MemoryTurnDeps;
	foldCeiling(): number | null;
	assertAuthority(): void;
}): PrefixSummarizer {
	const { conv, step, store, tools } = input;
	const view: ViewContext = {
		convId: conv.id,
		modelRef: step.modelRef,
		tools,
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
		async call(turns, signal) {
			input.assertAuthority();
			const ceiling = input.foldCeiling();
			const entries = store.modelEntries(conv.id).filter(
				(e) => ceiling === null || e.seq < ceiling,
			);
			const messages = await buildModelView(view, {
				entries,
				prior,
				current: null,
				partial: null,
				summarySeq: store.memoryEligibility(conv.id).summarySeq,
				ownedSeqs: [],
				assertAuthority: input.assertAuthority,
			});
			const sdkTools: ToolSet = Object.fromEntries(
				Object.entries(toToolSet(tools)).map(([name, definition]) => {
					const { execute: _execute, ...toolDefinition } = definition;
					return [name, toolDefinition];
				}),
			);
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
