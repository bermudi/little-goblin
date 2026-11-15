// index.ts binds configRef/auth/observation and spreads this into
// RuntimeDeps — the shape is RuntimeDeps["buildStep"|"compaction"].

import { generateText, isStepCount } from "ai";
import type { RuntimeDeps } from "../runtime.ts";

import type { ConfigRef } from "../config.ts";
import { splitModelRef, type ThinkingLevel } from "../config-schema.ts";
import type { AuthStore } from "../auth.ts";
import type { CacheObservation } from "../cache-observation.ts";
import type { Conversation } from "../conversation-read.ts";
import type { ConversationStore } from "../conversation.ts";
import type { NoteStore } from "../notes.ts";
import type { ProjectStore } from "../projects.ts";
import type { MediaPosition } from "./attachments.ts";
import { codexContextWindow } from "./codex/models.ts";
import { contextLimit, contextLimitDetailed, inputModalities } from "./models-dev.ts";
import { modelCallMaxRetries } from "./onemin.ts";
import { systemPromptFor } from "./prompt.ts";
import { cacheRouteFor, carriesMedia, observedModel, resolveModel } from "./providers.ts";
import { codexSessionId } from "./codex/session.ts";
import { thinkingOptions } from "./thinking.ts";
import { noteTool } from "./tools/note.ts";
import { toolNames } from "./tools/mod.ts";
import { log } from "../log.ts";
import type { ClaudeEngine } from "./claude-code/mod.ts";

// A flush reads notes before it edits them: list, read, then a few writes.
const FLUSH_MAX_STEPS = 8;

const FLUSH_SYSTEM = [
	"You are goblin, about to lose the conversation span below from your context: it is being folded into a summary.",
	"Save to your notes, with the note tool, any durable fact from it that you would need later and that is not already in a note:",
	"operator preferences, decisions, standing rules, names, paths, and commitments.",
	"Do not save chatter, one-off task state, or anything secret. Read a note before you edit it; prefer append.",
	"If nothing is worth saving, call no tool. Your text reply is discarded; no one reads it.",
].join("\n");

export interface StepBuilderDeps {
	configRef: ConfigRef;
	auth: AuthStore;
	store: ConversationStore;
	projects: ProjectStore;
	notes: NoteStore;
	observation: CacheObservation;
	// Present iff a claude-code provider is configured (index.ts binds
	// it unconditionally; tests may omit it). Builds ClaudeStep turns.
	claudeEngine?: ClaudeEngine | undefined;
}

export function makeStepBuilder(
	deps: StepBuilderDeps,
): Pick<RuntimeDeps, "buildStep" | "compaction"> {
	const { configRef, auth, store, projects, notes, observation } = deps;
	// The provider side of one compaction-lane call: model, thinking, and
	// the retry rule, shared by the summary and the flush.
	const compactCall = async (
		conv: Conversation,
		modelRef: string,
		purpose: "compaction" | "compaction-flush",
	) => {
		const cfg = configRef.current;
		const model = observedModel(
			await resolveModel(cfg, auth, modelRef, {
				sessionId: codexSessionId(conv.id),
				subagent: "compact",
			}),
			{ conversation: conv.id, purpose, observation, route: cacheRouteFor(cfg, modelRef) },
		);
		const providerOptions = thinkingOptions(cfg, modelRef, conv.thinking as ThinkingLevel);
		// Same provider rule as the turn step — 1min sends no SDK retries.
		const maxRetries = modelCallMaxRetries(cfg, modelRef);
		return {
			model,
			...(providerOptions ? { providerOptions } : {}),
			...(maxRetries !== undefined ? { maxRetries } : {}),
		};
	};
	// One summary call on one ref — the fallback walk below picks refs.
	const summarizeOn = async (
		conv: Conversation,
		modelRef: string,
		system: string,
		prompt: string,
		signal: AbortSignal,
	): Promise<string> => {
		const cfg = configRef.current;
		const { provider, modelId } = splitModelRef(modelRef);
		const p = cfg.providers[provider];
		// Compaction rides the same engine as the turn — a claude-code
		// conversation summarizes on its subscription too (text-only,
		// tools off, one call).
		if (p?.kind === "claude-code") {
			if (deps.claudeEngine === undefined) {
				throw new Error(
					`compaction for ${conv.id} uses claude-code model ${modelRef} but no claude engine is bound`,
				);
			}
			return deps.claudeEngine.compact({
				modelId,
				auth: p.auth ?? "claude-code",
				system,
				prompt,
				signal,
			});
		}
		const { text } = await generateText({
			...(await compactCall(conv, modelRef, "compaction")),
			instructions: system,
			prompt,
			abortSignal: signal,
		});
		return text;
	};
	return {
		async buildStep(conv, tools) {
			const cfg = configRef.current;
			const modelRef = conv.model!;
			const { provider, modelId } = splitModelRef(modelRef);
			const p = cfg.providers[provider];
			const kind = p?.kind ?? "";
			// The codex catalog is the account's own truth for its slugs —
			// its context_window replaces the models.dev borrow (models.dev
			// has no codex key; the borrow guessed from another provider's
			// row). A cold catalog answers null and kicks the fetch for the
			// next turn, and the models.dev lookup is skipped entirely.
			const contextWindowFor = async (): Promise<number | null> => {
				const codexWindow = p?.kind === "codex" ? codexContextWindow(modelId, p.authFile) : null;
				if (codexWindow !== null) return codexWindow;
				const info = await contextLimitDetailed(provider, modelId);
				if (info?.source === "cross-provider") {
					log.warn("context window borrowed from another provider's catalog entry", {
						conversation: conv.id,
						model: modelRef,
						catalogProvider: info.catalogProvider,
						limit: info.limit,
					});
				}
				return info?.limit ?? null;
			};
			// Catalog truth alone once cost a thrown turn — openai-compatible
			// < v3 rejected file parts its converter now carries.
			// Pipe truth is host-aware: 1min's relay carries no media at all.
			const pipeBase = p !== undefined && "baseUrl" in p ? p.baseUrl : undefined;
			const carries = (mediaType: string, position: MediaPosition): boolean =>
				carriesMedia(kind, mediaType, position, pipeBase);
			const level = conv.thinking as ThinkingLevel;
			const project = conv.projectId === null ? null : projects.get(conv.projectId);
			const prompt = systemPromptFor(
				store,
				conv,
				toolNames(tools),
				project,
				project === null ? undefined : notes.index(project.id),
			);
			log.info("model step", {
				conversation: conv.id,
				model: modelRef,
				thinking: level,
				prompt: prompt.sources.join("+"),
			});
			// The subscription lane: no resolveModel (the child CLI owns the
			// API surface); the auth record rides the step and the engine
			// resolves it into the child env only.
			if (p?.kind === "claude-code") {
				if (deps.claudeEngine === undefined) {
					throw new Error(
						`conversation ${conv.id} uses claude-code model ${modelRef} but no claude engine is bound`,
					);
				}
				const [modalities, contextWindow] = await Promise.all([
					inputModalities(provider, modelId),
					contextWindowFor(),
				]);
				const thinking = thinkingOptions(cfg, modelRef, level)?.["claude-code"] ?? {};
				return {
					engine: "claude-code" as const,
					label: modelRef,
					modelId,
					auth: p.auth ?? "claude-code",
					system: prompt.text,
					thinking,
					inputModalities: modalities,
					carries,
					...(contextWindow !== null ? { contextWindow } : {}),
					// No maxTurns: a turn has no step budget (design/model.md).
				};
			}
			// Auth "!command" and the catalog fetch may both be slow — run in parallel.
			const [model, modalities, contextWindow] = await Promise.all([
				resolveModel(cfg, auth, modelRef, { sessionId: codexSessionId(conv.id) }),
				inputModalities(provider, modelId),
				contextWindowFor(),
			]);
			const providerOptions = thinkingOptions(cfg, modelRef, level);
			// 1min bills every attempt — its chat calls carry no SDK retry
			// budget.
			const maxRetries = modelCallMaxRetries(cfg, modelRef);
			return {
				// Observed at the model boundary — tool-loop continuations included.
				model: observedModel(model, {
					conversation: conv.id,
					observation,
					route: cacheRouteFor(cfg, modelRef),
				}),
				system: prompt.text,
				label: modelRef,
				inputModalities: modalities,
				carries,
				keepProviderExecuted: kind === "codex",
				...(contextWindow !== null ? { contextWindow } : {}),
				...(providerOptions ? { providerOptions } : {}),
				...(maxRetries !== undefined ? { maxRetries } : {}),
			};
		},
		compaction: {
			modelRef: (conv) => conv.model!,
			// Metadata only — a catalog read. Resolving auth or building the
			// prompt here would let a compaction pass mint a snapshot; the
			// frozen prompt belongs to buildStep alone. Codex reads its own
			// account catalog first, same precedence as buildStep.
			contextWindow: async (conv) => {
				const cfg = configRef.current;
				const { provider, modelId } = splitModelRef(conv.model!);
				const p = cfg.providers[provider];
				if (p?.kind === "codex") {
					const codex = codexContextWindow(modelId, p.authFile);
					if (codex !== null) return codex;
				}
				return contextLimit(provider, modelId);
			},
			// One call on the ref runCompaction's fallback walk hands it
			// (design/model.md → Model fallback list → Compaction).
			summarize: (conv, system, prompt, signal, modelRef) =>
				summarizeOn(conv, modelRef, system, prompt, signal),
			// #418: the recorded native session compacts itself alongside
			// the goblin fold — same (conversation, model ref) keying as
			// the turn records. No-op without a claude engine or record.
			nativeCompact: async (conv, modelRef, signal) => {
				const engine = deps.claudeEngine;
				if (engine === undefined) return;
				const cfg = configRef.current;
				const { provider } = splitModelRef(modelRef);
				if (cfg.providers[provider]?.kind !== "claude-code") return;
				await engine.nativeCompact({ conversationId: conv.id, modelRef, signal });
			},
			// design/compaction.md → Memory flush. With Hindsight on, the
			// outbox already carries every event; an excluded conversation
			// lets nothing durable leave. The claude-code engine's compact
			// call is text-only, so it has no note tool to flush with.
			flush: (conv, modelRef) => {
				const cfg = configRef.current;
				const skip =
					cfg.memory !== undefined
						? "memory configured"
						: conv.memoryExcluded
							? "memory excluded"
							: cfg.providers[splitModelRef(modelRef).provider]?.kind === "claude-code"
								? "claude-code engine has no tools on the compaction lane"
								: null;
				if (skip !== null) {
					log.debug("compaction flush skipped", { conversation: conv.id, why: skip });
					return null;
				}
				return async (spanText, signal) => {
					const result = await generateText({
						...(await compactCall(conv, modelRef, "compaction-flush")),
						instructions: FLUSH_SYSTEM,
						prompt: spanText,
						tools: {
							note: noteTool({
								notes,
								projects,
								conversation: conv.id,
								projectId: conv.projectId,
							}),
						},
						stopWhen: isStepCount(FLUSH_MAX_STEPS),
						abortSignal: signal,
					});
					return {
						noteCalls: result.steps.reduce((n, step) => n + step.toolCalls.length, 0),
					};
				};
			},
		},
	};
}
