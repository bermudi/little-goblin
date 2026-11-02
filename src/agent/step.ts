// index.ts binds configRef/auth/observation and spreads this into
// RuntimeDeps — the shape is RuntimeDeps["buildStep"|"compaction"].

import { generateText } from "ai";
import type { RuntimeDeps } from "../runtime.ts";
import { splitModelRef, type ConfigRef, type ThinkingLevel } from "../config.ts";
import type { AuthStore } from "../auth.ts";
import type { CacheObservation } from "../cache-observation.ts";
import type { ConversationStore } from "../conversation.ts";
import type { NoteStore } from "../notes.ts";
import type { ProjectStore } from "../projects.ts";
import type { MediaPosition } from "./attachments.ts";
import { codexContextWindow } from "./codex/models.ts";
import { contextLimit, contextLimitDetailed, inputModalities } from "./models-dev.ts";
import { modelCallMaxRetries } from "./onemin.ts";
import { systemPromptFor } from "./prompt.ts";
import { cacheRouteFor, carriesMedia, observedModel, resolveModel } from "./providers.ts";
import { thinkingOptions } from "./thinking.ts";
import { toolNames } from "./tools/mod.ts";
import { log } from "../log.ts";

export interface StepBuilderDeps {
	configRef: ConfigRef;
	auth: AuthStore;
	store: ConversationStore;
	projects: ProjectStore;
	notes: NoteStore;
	observation: CacheObservation;
}

export function makeStepBuilder(
	deps: StepBuilderDeps,
): Pick<RuntimeDeps, "buildStep" | "compaction"> {
	const { configRef, auth, store, projects, notes, observation } = deps;
	return {
		async buildStep(conv, tools) {
			const cfg = configRef.current;
			const modelRef = conv.model!;
			const { provider, modelId } = splitModelRef(modelRef);
			// Catalog truth alone once cost a thrown turn — openai-compatible
			// < v3 rejected file parts its converter now carries.
			const p = cfg.providers[provider];
			const kind = p?.kind ?? "";
			// The codex catalog is the account's own truth for its slugs —
			// its context_window replaces the models.dev borrow (models.dev
			// has no codex key; the borrow guessed from another provider's
			// row). A cold catalog answers null and kicks the fetch for the
			// next turn, and the models.dev lookup is skipped entirely.
			const codexWindow =
				p?.kind === "codex" ? codexContextWindow(modelId, p.authFile) : null;
			// Auth "!command" and the catalog fetch may both be slow — run in parallel.
			const [model, modalities, contextLimitInfo] = await Promise.all([
				resolveModel(cfg, auth, modelRef),
				inputModalities(provider, modelId),
				codexWindow !== null ? Promise.resolve(null) : contextLimitDetailed(provider, modelId),
			]);
			const contextWindow = codexWindow ?? contextLimitInfo?.limit ?? null;
			if (codexWindow === null && contextLimitInfo?.source === "cross-provider") {
				log.warn("context window borrowed from another provider's catalog entry", {
					conversation: conv.id,
					model: modelRef,
					catalogProvider: contextLimitInfo.catalogProvider,
					limit: contextLimitInfo.limit,
				});
			}
			// Pipe truth is host-aware: 1min's relay carries no media at all.
			const pipeBase = p !== undefined && "baseUrl" in p ? p.baseUrl : undefined;
			const carries = (mediaType: string, position: MediaPosition): boolean =>
				carriesMedia(kind, mediaType, position, pipeBase);
			const level = conv.thinking as ThinkingLevel;
			const providerOptions = thinkingOptions(cfg, modelRef, level);
			// 1min bills every attempt — its chat calls carry no SDK retry
			// budget.
			const maxRetries = modelCallMaxRetries(cfg, modelRef);
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
			summarize: async (conv, system, prompt, signal) => {
				const cfg = configRef.current;
				const modelRef = conv.model!;
				const model = observedModel(await resolveModel(cfg, auth, modelRef), {
					conversation: conv.id,
					purpose: "compaction",
					observation,
					route: cacheRouteFor(cfg, modelRef),
				});
				const providerOptions = thinkingOptions(cfg, modelRef, conv.thinking as ThinkingLevel);
				// Same provider rule as the turn step — 1min sends no SDK
				// retries.
				const maxRetries = modelCallMaxRetries(cfg, modelRef);
				const { text } = await generateText({
					model,
					instructions: system,
					prompt,
					abortSignal: signal,
					...(providerOptions ? { providerOptions } : {}),
					...(maxRetries !== undefined ? { maxRetries } : {}),
				});
				return text;
			},
		},
	};
}
