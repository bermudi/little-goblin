import { generateText, isStepCount, type LanguageModel, type ToolSet } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { MediaPosition } from "../agent/attachments.ts";
import { keptTailInstruction, type PrefixSummarizer } from "../agent/compaction.ts";
import type { Conversation } from "../conversation-read.ts";
import type { ConversationStore } from "../conversation.ts";
import type { MemoryTurnDeps } from "../memory/mod.ts";
import type { Message } from "../message.ts";
import type { PromptMessage } from "../prompt-message.ts";
import { omitFunctionToolsFromRequest, toolSetDeclarations } from "./ai-sdk-tools.ts";
import { diffDeclarations, foldDeclarations, storedToolChanges } from "../agent/tool-declarations.ts";
import { buildModelView, type ViewContext } from "./view.ts";
import { resolveSkillRef } from "../agent/skill-inject.ts";
import { fromSdkError } from "../agent/sdk-errors.ts";

const FLUSH_SYSTEM = [
	"You are goblin, about to lose the conversation span below from your context: it is being folded into a summary.",
	"Save to your notes, with the note tool, any durable fact from it that you would need later and that is not already in a note:",
	"operator preferences, decisions, standing rules, names, paths, and commitments.",
	"Do not save chatter, one-off task state, or anything secret. Read a note before you edit it; prefer append.",
	"If nothing is worth saving, call no tool. Your text reply is discarded; no one reads it.",
].join("\n");
const FLUSH_MAX_STEPS = 8;
const FLUSH_REFUSAL = "refused: only the note tool runs during the memory flush";

export interface PrefixStep {
	modelRef: string;
	model: LanguageModel;
	system: string;
	providerOptions?: ProviderOptions;
	maxRetries?: number;
	inputModalities: Set<string> | undefined;
	carries(mediaType: string, position: MediaPosition): boolean;
	keepProviderExecuted: boolean;
	toolsInInput?: boolean;
}

export function makePrefixSummarizer(input: {
	conv: Conversation;
	step: PrefixStep;
	store: ConversationStore;
	tools: ToolSet;
	hydratedModelOutputTools?: readonly string[];
	memory?: MemoryTurnDeps;
	foldCeiling(): number | null;
	assertAuthority(): void;
}): PrefixSummarizer {
	return makePrefixRequest(input, input.tools);
}

export function makePrefixFlush(input: {
	conv: Conversation;
	step: PrefixStep;
	store: ConversationStore;
	tools: ToolSet;
	noteExecutor: NonNullable<ToolSet[string]["execute"]>;
	hydratedModelOutputTools?: readonly string[];
	memory?: MemoryTurnDeps;
	foldCeiling(): number | null;
	assertAuthority(): void;
}): ((keptExcerpt: string | null, hasPreviousSummary: boolean, signal: AbortSignal) => Promise<number>) | null {
	const noteDefinition = input.tools.note;
	if (
		noteDefinition === undefined ||
		!("execute" in noteDefinition) ||
		typeof noteDefinition.execute !== "function"
	) {
		return null;
	}
	const flushTools: ToolSet = {};
	for (const [name, definition] of Object.entries(input.tools)) {
		if (!("execute" in definition) || typeof definition.execute !== "function") {
			flushTools[name] = definition;
		} else if (name === "note") {
			flushTools[name] = { ...definition, execute: input.noteExecutor };
		} else {
			flushTools[name] = {
				...definition,
				execute: async () => FLUSH_REFUSAL,
			};
		}
	}
	let noteCalls = 0;
	const request = makePrefixRequest(input, flushTools, FLUSH_MAX_STEPS, (result) => {
		noteCalls = result.steps.reduce((count, step) => count + step.toolCalls.filter((call) => call.toolName === "note").length, 0);
	});
	return async (keptExcerpt, hasPreviousSummary, signal) => {
		const instruction = `${FLUSH_SYSTEM}\n\n${keptTailInstruction(keptExcerpt)}${
			hasPreviousSummary
				? "\nThe conversation above begins with the summary of an earlier compaction; include its durable facts."
				: ""
		}`;
		await request.call([{ role: "user", text: instruction }], signal);
		return noteCalls;
	};
}

function makePrefixRequest(
	input: {
		conv: Conversation;
		step: PrefixStep;
		store: ConversationStore;
		tools: ToolSet;
		hydratedModelOutputTools?: readonly string[];
		memory?: MemoryTurnDeps;
		foldCeiling(): number | null;
		assertAuthority(): void;
	},
	sdkTools: ToolSet,
	maxSteps?: number,
	onResult?: (result: {
		steps: readonly { toolCalls: readonly { toolName: string }[] }[];
	}) => void,
): PrefixSummarizer {
	const { conv, step, store, tools } = input;
	const requestTools = step.toolsInInput === true ? omitFunctionToolsFromRequest(sdkTools) : sdkTools;
	const hydratedModelOutputTools = new Set(input.hydratedModelOutputTools ?? []);
	const view: ViewContext = {
		convId: conv.id,
		modelRef: step.modelRef,
		tools: {},
		sdkTools: tools,
		modalities: step.inputModalities,
		carries: step.carries,
		keepProviderExecuted: step.keepProviderExecuted,
		toolsInInput: step.toolsInInput === true,
		skillRef: resolveSkillRef,
	};
	const withPendingTools = async (toolHistory: { message: Message }[]): Promise<ViewContext> => {
		if (view.toolsInInput !== true) return view;
		const stored = foldDeclarations(storedToolChanges(toolHistory, conv.id).map(({ change }) => change));
		return { ...view, pendingToolChange: diffDeclarations(stored, await toolSetDeclarations(tools)) };
	};
	const prior =
		input.memory === undefined || conv.memoryExcluded
			? []
			: input.memory.contexts.load(conv.id);
	return {
		async prepare() {
			input.assertAuthority();
			const ceiling = input.foldCeiling();
			const entries = store.modelEntries(conv.id).filter(
				(entry) => ceiling === null || entry.seq < ceiling,
			);
			const toolHistory = store.toolHistoryEntries(conv.id).filter(
				(entry) => ceiling === null || entry.seq < ceiling,
			);
			if (hydratedModelOutputTools.size > 0) {
				for (const entry of entries) {
					for (const part of entry.message.parts) {
						const toolPart = part as { type: string; state?: string; toolName?: string };
						const toolName =
							toolPart.type === "dynamic-tool"
								? toolPart.toolName
								: toolPart.type.startsWith("tool-")
									? toolPart.type.slice("tool-".length)
									: undefined;
						if (
							toolPart.state === "output-available" &&
							toolName !== undefined &&
							hydratedModelOutputTools.has(toolName)
						) {
							throw new Error(`hydrated tool ${toolName} needs toModelOutput`);
						}
					}
				}
			}
			await buildModelView(await withPendingTools(toolHistory), {
				entries,
				toolHistory,
				prior,
				current: null,
				partial: null,
				summarySeq: store.memoryEligibility(conv.id).summarySeq,
				ownedSeqs: [],
				assertAuthority: input.assertAuthority,
			});
		},
		async call(turns, signal, cut) {
			input.assertAuthority();
			const ceiling = input.foldCeiling();
			let entries = store.modelEntries(conv.id).filter(
				(e) => ceiling === null || e.seq < ceiling,
			);
			let partial: Message | null = null;
			let partialInsertLimit: number | undefined;
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
				partialInsertLimit =
					partial.parts.filter((part) => part.type === "step-start").length +
					(cutEntry.message.parts[cut.part]?.type === "step-start" ? 1 : 0);
			}
			const fullToolHistory = store.toolHistoryEntries(conv.id);
			let toolHistory = fullToolHistory.filter(
				(entry) => ceiling === null || entry.seq < ceiling,
			);
			if (cut !== undefined) {
				toolHistory = toolHistory.flatMap((entry) => {
					if (entry.seq < cut.seq) return [entry];
					if (entry.seq > cut.seq) return [];
					const cutEntry = fullToolHistory.find((item) => item.seq === cut.seq);
					return cutEntry === undefined
						? []
						: [{ ...cutEntry, message: { ...cutEntry.message, parts: cutEntry.message.parts.slice(0, cut.part) } }];
				});
			}
			if (hydratedModelOutputTools.size > 0) {
				for (const entry of [...entries, ...(partial === null ? [] : [{ message: partial }])]) {
					for (const part of entry.message.parts) {
						const toolPart = part as { type: string; state?: string; toolName?: string };
						const toolName =
							toolPart.type === "dynamic-tool"
								? toolPart.toolName
								: toolPart.type.startsWith("tool-")
									? toolPart.type.slice("tool-".length)
									: undefined;
						if (
							toolPart.state === "output-available" &&
							toolName !== undefined &&
							hydratedModelOutputTools.has(toolName)
						) {
							throw new Error(`hydrated tool ${toolName} needs toModelOutput`);
						}
					}
				}
			}
			const messages = await buildModelView(await withPendingTools(toolHistory), {
				entries,
				toolHistory,
				prior,
				current: null,
				partial,
				...(partialInsertLimit === undefined ? {} : { partialInsertLimit }),
				summarySeq: store.memoryEligibility(conv.id).summarySeq,
				ownedSeqs: [],
				assertAuthority: input.assertAuthority,
			});
			const requestMessages: PromptMessage[] = [
				...messages,
				...turns.map((turn): PromptMessage => ({ role: turn.role, content: turn.text })),
			];
			const result = await generateText({
				allowSystemInMessages: step.toolsInInput === true,
				model: step.model,
				instructions: step.system,
				tools: requestTools,
				messages: requestMessages,
				...(step.providerOptions !== undefined ? { providerOptions: step.providerOptions } : {}),
				...(step.maxRetries !== undefined ? { maxRetries: step.maxRetries } : {}),
				...(maxSteps !== undefined ? { stopWhen: isStepCount(maxSteps) } : {}),
				abortSignal: signal,
			}).catch((err: unknown) => {
				throw fromSdkError(err);
			});
			onResult?.(result);
			return result.text;
		},
	};
}
