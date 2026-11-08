// The step-builder fork: a claude-code provider builds a ClaudeStep
// (auth record riding the step, no resolveModel, thinking arm
// extracted, no step budget) and routes compaction to the engine —
// an unbound engine fails loud, never silently degrades.

import { describe, expect, test } from "bun:test";
import type { Config, ConfigRef } from "../../config.ts";
import { openStore } from "../../conversation.ts";
import { openNotes } from "../../notes.ts";
import { openProjects } from "../../projects.ts";
import { tmpDb, useHome } from "../../testkit.ts";
import { makeStepBuilder } from "../step.ts";
import { isClaudeStep } from "../../turn/engine.ts";
import type { ClaudeEngine } from "./mod.ts";

const fakeEngine: ClaudeEngine = {
	id: "claude-code",
	accepts: isClaudeStep,
	run: (() => {
		throw new Error("not driven in this suite");
	}) as never,
	compact: async () => "summary-text",
};

function rig(
	providers: Config["providers"],
	opts: { modelFallbacks?: string[]; engine?: ClaudeEngine } = {},
) {
	const home = useHome("claude-step-");
	const store = openStore(tmpDb("claude-step-"));
	const projects = openProjects(store, { memoryQueue: store.memoryQueue });
	const notes = openNotes(store, { projects });
	const configRef: ConfigRef = {
		current: { providers, modelFallbacks: opts.modelFallbacks ?? ([] as string[]) } as Config,
		ttsDown: false,
	};
	const conv = store.resolve(
		{ kind: "app", appId: "app-step", chatId: 0, threadId: 0 },
		home,
	) as never as Parameters<ReturnType<typeof makeStepBuilder>["buildStep"]>[0];
	conv.model = "claude/claude-sonnet-4-5";
	return {
		builder: makeStepBuilder({
			configRef,
			auth: null as never,
			store,
			projects,
			notes,
			observation: null as never,
			claudeEngine: opts.engine ?? fakeEngine,
		}),
		conv,
		store,
	};
}

describe("makeStepBuilder — claude-code fork", () => {
	test("a claude-code provider builds a ClaudeStep with the auth record riding it", async () => {
		const { builder, conv } = rig({ claude: { kind: "claude-code", auth: "cc-token" } });
		const step = await builder.buildStep(conv, {});
		expect(step).toMatchObject({
			engine: "claude-code",
			label: "claude/claude-sonnet-4-5",
			modelId: "claude-sonnet-4-5",
			auth: "cc-token",
			system: expect.stringContaining("goblin"),
		});
		expect("model" in step).toBe(false);
		expect("maxTurns" in step).toBe(false);
	});

	test("the parsed default auth record (filled at config parse) rides the step verbatim", async () => {
		// The parse-time default is "claude-code" (config.test.ts pins it);
		// buildStep consumes the parsed shape, where auth is always set.
		const { builder, conv } = rig({ claude: { kind: "claude-code", auth: "claude-code" } });
		const step = await builder.buildStep(conv, {});
		expect(step).toMatchObject({ engine: "claude-code", auth: "claude-code" });
	});

	test("an unbound engine fails loud, not silently", async () => {
		const home = useHome("claude-step-");
		const store = openStore(tmpDb("claude-step-"));
		const projects = openProjects(store, { memoryQueue: store.memoryQueue });
		const notes = openNotes(store, { projects });
		const conv = store.resolve(
			{ kind: "app", appId: "app-step", chatId: 0, threadId: 0 },
			home,
		) as never as Parameters<ReturnType<typeof makeStepBuilder>["buildStep"]>[0];
		conv.model = "claude/claude-sonnet-4-5";
		const builder = makeStepBuilder({
			configRef: {
				current: {
					providers: { claude: { kind: "claude-code", auth: "claude-code" } },
				} as unknown as Config,
				ttsDown: false,
			},
			auth: null as never,
			store,
			projects,
			notes,
			observation: null as never,
		});
		await expect(builder.buildStep(conv, {})).rejects.toThrow("no claude engine is bound");
	});

	test("compaction summarize runs on the ref the walk hands it", async () => {
		const asked: string[] = [];
		const engine: ClaudeEngine = {
			...fakeEngine,
			compact: async ({ modelId }) => {
				asked.push(modelId);
				return `summary-from-${modelId}`;
			},
		};
		const { builder, conv } = rig(
			{
				claude: { kind: "claude-code", auth: "claude-code" },
				backup: { kind: "claude-code", auth: "claude-code" },
			},
			{ engine },
		);
		const signal = new AbortController().signal;
		expect(await builder.compaction!.summarize(conv, "sys", "prompt", signal, conv.model!)).toBe(
			"summary-from-claude-sonnet-4-5",
		);
		// A fallback ref routes to its own model, never conv.model.
		expect(
			await builder.compaction!.summarize(conv, "sys", "prompt", signal, "backup/claude-haiku-4-5"),
		).toBe("summary-from-claude-haiku-4-5");
		expect(asked).toEqual(["claude-sonnet-4-5", "claude-haiku-4-5"]);
	});
});
