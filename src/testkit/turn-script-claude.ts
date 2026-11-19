import { type ClaudeEngineConfig, driveClaude } from "../agent/claude-code/engine.ts";
import { isClaudeStep, type ClaudeEngine, type ClaudeStep } from "../agent/claude-code/mod.ts";
import type { ClaudeQuery } from "../agent/claude-code/translate.ts";
import { createToolBridge, type ToolBridge } from "../agent/claude-code/tools.ts";
import type { AuthStore } from "../auth.ts";
import type { ConfigRef } from "../config.ts";
import { configSchema } from "../config-schema.ts";
import { tmpDir } from "../testkit.ts";
import { fakeClaude, type FakeStep, type FakeUsageInput } from "./fake-claude.ts";
import type { ScriptCall, ScriptedModel, ScriptUsage } from "./turn-script.ts";

const auth: AuthStore = {
	resolve: async (name) => `token-for-${name}`,
	has: () => true,
	names: () => ["claude-code"],
};

const usageInput = (usage: ScriptUsage): FakeUsageInput => ({
	inputTokens: usage.input,
	outputTokens: usage.output,
	...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
	...(usage.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
});

function scriptCall(call: ScriptCall, bridgeRef: { current: ToolBridge | null }): FakeStep[] {
	const steps: FakeStep[] = [];
	for (const part of call.parts) {
		if (part.type === "text") {
			steps.push({
				kind: "stream-text",
				text: part.text,
				...(call.kind !== "fail" && call.usage !== undefined ? { usage: usageInput(call.usage) } : {}),
			});
		} else if (part.type === "reasoning") {
			if (call.kind === "fail") {
				throw new Error("claude-code cannot script reasoning followed by failure");
			}
			steps.push({
				kind: "reasoning",
				text: part.text,
				...(call.usage !== undefined ? { usage: usageInput(call.usage) } : {}),
			});
		} else {
			steps.push({
				kind: "tool",
				name: part.toolName,
				input: part.input,
				run: () => bridgeRef.current!.invoke(part.toolName, part.input),
			});
		}
	}
	if (call.kind === "hold") {
		steps.push({
			kind: "hold",
			...(call.entered !== undefined ? { onEnter: call.entered } : {}),
			until: call.gate,
		});
	}
	if (call.kind === "fail") {
		steps.push({ kind: "error", resultText: call.error.message });
	}
	return steps;
}

function queryScripts(calls: ScriptCall[], bridgeRef: { current: ToolBridge | null }): FakeStep[][] {
	const scripts: FakeStep[][] = [];
	let current: FakeStep[] = [];
	for (const call of calls) {
		const steps = scriptCall(call, bridgeRef);
		current.push(...steps);
		if (call.kind === "fail" || !call.parts.some((part) => part.type === "tool-call")) {
			scripts.push(current);
			current = [];
		}
	}
	if (current.length > 0) scripts.push(current);
	return scripts;
}

export function claudeScript(opts: { label?: string; system?: string } = {}): ScriptedModel {
	const fake = fakeClaude();
	const scripts: FakeStep[][] = [];
	const bridgeRef: { current: ToolBridge | null } = { current: null };
	const query: ClaudeQuery = (call) => {
		const steps = scripts.shift();
		if (steps === undefined) {
			throw new Error("claude-code script exhausted: unexpected CLI query");
		}
		fake.scriptSequence([steps]);
		return fake.query(call);
	};
	const engineConfig: ClaudeEngineConfig = {
		query,
		auth,
		configRef: {
			current: configSchema.parse({
				providers: { claude: { kind: "claude-code", auth: "claude-code" } },
				model: "claude/claude-sonnet-4-5",
				operators: [],
				telegram: { enabled: false },
			}),
			ttsDown: false,
		} satisfies ConfigRef,
		configDir: tmpDir("goblin-turn-script-claude-"),
		bridgeFactory: (deps) => {
			const bridge = createToolBridge(deps);
			bridgeRef.current = bridge;
			return bridge;
		},
	};
	const engine: ClaudeEngine = {
		id: "claude-code",
		accepts: isClaudeStep,
		run: (deps) => driveClaude(engineConfig, deps),
		compact: async () => {
			throw new Error("compaction not exercised");
		},
		nativeCompact: async () => null,
	};
	const step: ClaudeStep = {
		engine: "claude-code",
		label: opts.label ?? "claude/claude-sonnet-4-5",
		modelId: "claude-sonnet-4-5",
		auth: "claude-code",
		system: opts.system ?? "test",
		thinking: {},
	};
	return {
		engineId: "claude-code",
		step: () => ({ ...step }),
		engines: [engine],
		script: (...calls) => {
			for (const call of calls) {
				if (call.kind === "reply" && call.finish !== undefined) {
					throw new Error(`claude-code cannot render finish: ${call.finish}`);
				}
				if (call.kind === "fail" && call.error.status !== undefined) {
					throw new Error("claude-code cannot render fail.error.status");
				}
			}
			scripts.push(...queryScripts(calls, bridgeRef));
		},
		calls: () => fake.calls.length,
		requests: () => null,
	};
}
