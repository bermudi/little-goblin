import { type ClaudeEngineConfig, driveClaude } from "../agent/claude-code/engine.ts";
import { createClaudeEngine, isClaudeStep, type ClaudeEngine, type ClaudeStep } from "../agent/claude-code/mod.ts";
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
	const scripted = call.kind === "fail" ? undefined : call.usage;
	if (scripted !== undefined && call.parts.length === 0) {
		throw new Error("claude-code cannot render usage on a call with no parts");
	}
	// The fake CLI bills every step (100/10 when unset), so the call's usage
	// goes on its first step and the rest bill zero: the call counts it once.
	let pending = scripted === undefined ? undefined : usageInput(scripted);
	const billed = (): { usage?: FakeUsageInput } => {
		if (scripted === undefined) return {};
		const usage = pending ?? { inputTokens: 0, outputTokens: 0 };
		pending = undefined;
		return { usage };
	};
	const steps: FakeStep[] = [];
	for (const part of call.parts) {
		if (part.type === "text") {
			steps.push({ kind: "stream-text", text: part.text, ...billed() });
		} else if (part.type === "reasoning") {
			if (call.kind === "fail") {
				throw new Error("claude-code cannot script reasoning followed by failure");
			}
			steps.push({ kind: "reasoning", text: part.text, ...billed() });
		} else {
			steps.push({
				kind: "tool",
				name: part.toolName,
				input: part.input,
				run: () => bridgeRef.current!.invoke(part.toolName, part.input),
				...billed(),
			});
		}
	}
	if (call.kind === "hold") {
		const hold = { ...(call.entered !== undefined ? { onEnter: call.entered } : {}), until: call.gate };
		// A trailing text part stays open across the hold, so the step is
		// mid-stream at `entered`, as on the ai-sdk side.
		const last = steps.at(-1);
		if (call.parts.at(-1)?.type === "text" && last?.kind === "stream-text") {
			steps[steps.length - 1] = { ...last, hold };
		} else {
			steps.push({ kind: "hold", ...hold });
		}
	}
	if (call.kind === "fail") {
		steps.push({
			kind: "error",
			resultText: call.error.message,
			...(call.error.status !== undefined ? { retryStatus: call.error.status } : {}),
			...(call.error.quota ? { assistantError: "rate_limit" } : {}),
		});
	}
	return steps;
}

export function claudeScript(opts: { label?: string; system?: string } = {}): ScriptedModel {
	const fake = fakeClaude();
	// One fake CLI query per entry. A query runs until a call without a tool
	// call (or a fail) ends it; `open` holds a query whose tool loop has not
	// ended yet, so a later script() call can continue it.
	const scripts: FakeStep[][] = [];
	let open: FakeStep[] = [];
	const bridgeRef: { current: ToolBridge | null } = { current: null };
	const query: ClaudeQuery = (call) => {
		let steps = scripts.shift();
		if (steps === undefined && open.length > 0) {
			steps = open;
			open = [];
		}
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
		rules: createClaudeEngine(engineConfig).rules,
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
			}
			for (const call of calls) {
				open.push(...scriptCall(call, bridgeRef));
				if (call.kind === "fail" || !call.parts.some((part) => part.type === "tool-call")) {
					scripts.push(open);
					open = [];
				}
			}
		},
		calls: () => fake.calls.length,
		requests: () => fake.calls.map((call) => JSON.stringify(call.prompt.blocks)),
	};
}
