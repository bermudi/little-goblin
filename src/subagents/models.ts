import type { Model } from "@earendil-works/pi-ai";
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";
import { z } from "zod";
import type { SubagentsConfig } from "../config.ts";
import type { SubagentKind } from "../subagent-runs.ts";
import { SubagentError } from "./errors.ts";

const KIND_MODEL_ID: Record<SubagentKind, string> = {
	worker: "glm-5.3",
	computer: "glm-5.3-flash",
};

export const subagentModelProfileSchema = z
	.object({
		id: z.string().min(1),
		input: z.array(z.enum(["text", "image"])).min(1),
		reasoning: z.boolean(),
		contextWindow: z.number().int().positive().safe(),
		maxTokens: z.number().int().positive().safe(),
		cost: z
			.object({
				input: z.number().finite().nonnegative(),
				output: z.number().finite().nonnegative(),
				cacheRead: z.number().finite().nonnegative(),
				cacheWrite: z.number().finite().nonnegative(),
			})
			.strict(),
		compat: z
			.object({
				supportsStore: z.literal(false),
				supportsDeveloperRole: z.literal(false),
				supportsReasoningEffort: z.literal(false),
				maxTokensField: z.literal("max_tokens"),
			})
			.strict(),
	})
	.strict()
	.refine((p) => p.maxTokens <= p.contextWindow, {
		message: "maxTokens must not exceed contextWindow",
	});
export type SubagentModelProfile = z.infer<typeof subagentModelProfileSchema>;

export type KindSpec = {
	kind: SubagentKind;
	providerId: string;
	modelId: string;
	thinking: "off" | "low" | "high";
	catalog: Model<"openai-completions">;
};

export function kindSpec(config: SubagentsConfig, kind: SubagentKind, profile?: unknown): KindSpec {
	const block = config[kind];
	if (block === undefined) {
		throw new SubagentError(`subagents.${kind} is not configured`);
	}
	const model = block.model;
	const providerId = `goblin-${kind}`;
	if (profile !== undefined) {
		const parsed = subagentModelProfileSchema.safeParse(profile);
		if (!parsed.success) {
			throw new SubagentError(`subagents.${kind} explicit model profile failed schema validation`);
		}
		const p = parsed.data;
		if (p.id !== model.id) {
			throw new SubagentError(
				`subagents.${kind} explicit model profile id does not match the configured model.id`,
			);
		}
		const needed = kind === "computer" ? ["text", "image"] : ["text"];
		const inputs = new Set<string>(p.input);
		if (!needed.every((i) => inputs.has(i))) {
			throw new SubagentError(
				`subagents.${kind} explicit model profile does not admit the required input modality`,
			);
		}
		if (model.thinking !== "off") {
			throw new SubagentError(
				`subagents.${kind} explicit model profile requires model.thinking "off" — no unverifiable effort mapping`,
			);
		}
		const catalog: Model<"openai-completions"> = {
			...p,
			name: p.id,
			api: "openai-completions",
			provider: providerId,
			baseUrl: model.baseUrl,
		};
		return { kind, providerId, modelId: p.id, thinking: "off", catalog };
	}
	if (model.id !== KIND_MODEL_ID[kind]) {
		throw new SubagentError(
			`subagents.${kind}.model.id must be ${KIND_MODEL_ID[kind]}, got ${JSON.stringify(model.id)} — no alternate subagent models`,
		);
	}
	if (model.thinking !== "low" && model.thinking !== "high") {
		throw new SubagentError(
			`subagents.${kind}.model.thinking must be "low" or "high" (the z.ai catalog maps no other level), got ${JSON.stringify(model.thinking)}`,
		);
	}
	const catalog = ZAI_MODELS[model.id as keyof typeof ZAI_MODELS];
	if (catalog === undefined) {
		throw new SubagentError(
			`model ${model.id} is not in the pinned pi-ai z.ai catalog — pin drifted, re-check the catalog`,
		);
	}
	return { kind, providerId, modelId: catalog.id, thinking: model.thinking, catalog };
}
