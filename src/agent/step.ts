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
import { contextLimit, inputModalities } from "./models-dev.ts";
import { systemPromptFor } from "./prompt.ts";
import {
	cacheRouteFor,
	carriesMedia,
	observedModel,
	resolveModel,
	thinkingOptions,
} from "./providers.ts";
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
			// Auth "!command" and the catalog fetch may both be slow — run in parallel.
			const [model, modalities, contextWindow] = await Promise.all([
				resolveModel(cfg, auth, modelRef),
				inputModalities(provider, modelId),
				contextLimit(provider, modelId),
			]);
			// Catalog truth alone once cost a thrown turn — openai-compatible
			// < v3 rejected file parts its converter now carries.
			const kind = cfg.providers[provider]?.kind;
			const carries = (mediaType: string, position: MediaPosition): boolean =>
				carriesMedia(kind ?? "", mediaType, position);
			const level = conv.thinking as ThinkingLevel;
			const providerOptions = thinkingOptions(cfg, modelRef, level);
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
			};
		},
		compaction: {
			modelRef: (conv) => conv.model!,
			// Metadata only — a catalog read. Resolving auth or building the
			// prompt here would let a compaction pass mint a snapshot; the
			// frozen prompt belongs to buildStep alone.
			contextWindow: (conv) => {
				const { provider, modelId } = splitModelRef(conv.model!);
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
				const { text } = await generateText({
					model,
					instructions: system,
					prompt,
					abortSignal: signal,
					...(providerOptions ? { providerOptions } : {}),
				});
				return text;
			},
		},
	};
}
