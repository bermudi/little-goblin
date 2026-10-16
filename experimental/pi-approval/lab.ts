// Shared construction for the approval-gate crash lab: a fake
// openai-completions edge served by the test process, one side-effecting
// `act` tool, and the registry in gated or raw trim. Used by child.ts
// (the killed process) and crash.test.ts (the reopening process), so a
// reopen always re-installs the same registrations the crashed process
// had — registries are process code, never stored.

import { appendFileSync } from "node:fs";
import {
	type CredentialStore,
	createModels,
	createProvider,
	InMemoryCredentialStore,
	Type,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
	createRegistry,
	defineExtension,
	defineTool,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { type ApprovalHost, gateTool } from "./gate.ts";

export const PROVIDER_ID = "lab";
export const MODEL_ID = "lab";

export async function makeModels(baseUrl: string) {
	const credentials: CredentialStore = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const provider = createProvider<"openai-completions">({
		id: PROVIDER_ID,
		name: "Approval lab",
		baseUrl,
		auth: {
			apiKey: {
				name: "Lab API key",
				// The credential store is pre-warmed below; resolution reads it.
				resolve: async (input) =>
					input.credential?.key === undefined
						? undefined
						: { auth: { apiKey: input.credential.key } },
			},
		},
		models: [
			{
				id: MODEL_ID,
				name: "Lab model",
				api: "openai-completions",
				provider: PROVIDER_ID,
				baseUrl,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
				contextWindow: 128_000,
				maxTokens: 4_096,
			},
		],
		api: openAICompletionsApi(),
	});
	models.setProvider(provider);
	await credentials.modify(PROVIDER_ID, async () => ({ type: "api_key", key: "lab" }));
	return models;
}

/** The side effect under test: every dispatch appends a marker line the
 *  parent can count. `hang: true` parks mid-effect — the crash point. */
export function makeActTool(hang: boolean, markerPath: string): ToolRegistration {
	return defineTool({
		name: "act",
		description: "Perform the one side effect",
		parameters: Type.Object({ target: Type.String() }),
		// Raw trim: pi-durable's default. An interrupted dispatch never
		// re-executes — the harness reports `interrupted` and the run
		// continues without any operator. (The gate trim overrides this.)
		execute: async (args) => {
			appendFileSync(markerPath, `${JSON.stringify({ target: args.target, pid: process.pid })}\n`);
			if (hang) await new Promise<never>(() => {});
			return { content: [{ type: "text", text: `acted on ${args.target}` }] };
		},
	});
}

export function buildRegistry(gated: boolean, act: ToolRegistration, host: ApprovalHost) {
	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: "approval-lab",
			tools: [gated ? gateTool(act, host) : act],
		}),
	);
	return registry;
}

export const MODEL_REF = { provider: PROVIDER_ID, modelId: MODEL_ID } as const;
