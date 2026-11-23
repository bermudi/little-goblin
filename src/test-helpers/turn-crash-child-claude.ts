import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineTool, type Tools } from "../tool.ts";
import { z } from "zod";
import type { AuthStore } from "../auth.ts";
import type { ConfigRef } from "../config.ts";
import type { Config } from "../config-schema.ts";
import { openStore } from "../conversation.ts";
import { setLogFile } from "../log.ts";
import { Runtime, userMessage } from "../runtime.ts";
import { driveClaude, type ClaudeEngineConfig } from "../agent/claude-code/engine.ts";
import { isClaudeStep, type ClaudeEngine } from "../agent/claude-code/mod.ts";
import { fakeClaude } from "../testkit/fake-claude.ts";
import { openTurnJournal } from "../turn-journal.ts";

const DB_PATH = process.env.DB_PATH ?? "";
const MARKER_PATH = process.env.MARKER_PATH ?? "";
if (DB_PATH === "" || MARKER_PATH === "") {
	throw new Error("DB_PATH/MARKER_PATH are required");
}
setLogFile(null);

const idle = () => new Promise<never>(() => {});
const fake = fakeClaude();
const auth: AuthStore = {
	resolve: async (name) => `token-for-${name}`,
	has: () => true,
	names: () => ["claude-code"],
};
const configRef: ConfigRef = {
	current: {
		providers: { claude: { kind: "claude-code", auth: "claude-code" } },
	} as unknown as Config,
	ttsDown: false,
};
const engineConfig: ClaudeEngineConfig = {
	query: fake.query,
	auth,
	configRef,
	configDir: join(dirname(DB_PATH), "claude-config"),
};
const engine: ClaudeEngine = {
	id: "claude-code",
	rules: {
		toolLaunchGate: false,
		preemptFold: false,
		contentFilterReask: false,
		transientRetry: false,
		contextFill: false,
	},
	accepts: isClaudeStep,
	run: (deps) => driveClaude(engineConfig, deps),
	compact: async () => "unused",
	nativeCompact: async () => null,
};
const tools: Tools = {
	declared: defineTool({
		description: "crash fixture",
		input: z.object({}),
		execute: () => {
			appendFileSync(MARKER_PATH, "dispatched\n");
			throw new Error("declared crash fixture dispatched");
		},
	}),
};
mkdirSync(dirname(DB_PATH), { recursive: true });
const store = openStore(DB_PATH);
const journal = openTurnJournal(store.db);
const conv = store.resolve({ kind: "dm", chatId: 1 }, join(dirname(DB_PATH), "ws"));
const runtime = new Runtime({
	store,
	engines: [engine],
	buildStep: () => ({
		engine: "claude-code",
		label: "claude/claude-sonnet-4-5",
		modelId: "claude-sonnet-4-5",
		auth: "claude-code",
		system: "crash test",
		thinking: {},
	}),
	turnJournal: journal,
});
runtime.mount({ makeTools: () => tools });
fake.script([
	{
		kind: "tool",
		name: "declared",
		input: {},
		run: () => new Promise(() => {}),
	},
]);
runtime.submit(conv, userMessage([{ type: "text", text: "run declared" }]), {
	delivery: "headless",
	onTextDelta() {},
	onReasoningDelta() {},
	onToolCall() {},
	async onDone() {},
});
await idle();
