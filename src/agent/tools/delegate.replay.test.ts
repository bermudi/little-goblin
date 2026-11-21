// Replay tests: a real codex stream was recorded once into
// fixtures/delegate-replay/<case>.json and now replays verbatim, so a
// change around the delegate tool call — the tool, the stores, the
// watcher — breaks a test without any model in CI. These tests say
// nothing about model behaviour; only live tests do. A changed prompt
// or tool description fails on purpose and prints the re-record
// command. Recordings are public: the prompts carry nothing private.
//
// Record mode (operator/agent only, never CI):
//   GOBLIN_MODEL_RECORD=1 bun test src/agent/tools/delegate.replay.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { stepCountIs, streamText } from "ai";
import { openDelegations, type DelegationsStore } from "../../delegations.ts";
import { startDelegationLifecycle } from "../../delegation-watcher.ts";
import type { DelegationLifecycle } from "../../delegation-lifecycle.ts";
import type { HcRunInfo, HcDelegation } from "../../hc-delegation.ts";
import { recordedModel, StaleRecordingError } from "../../testkit/model-replay.ts";
import { tmpDir, useHome } from "../../testkit.ts";
import { delegateTool } from "./delegate.ts";
import { toToolSet } from "../../turn/ai-sdk-tools.ts";


const RERECORD = "GOBLIN_MODEL_RECORD=1 bun test src/agent/tools/delegate.replay.test.ts";
const RECORD = process.env.GOBLIN_MODEL_RECORD === "1";
const CASSETTES = join(import.meta.dir, "fixtures", "delegate-replay");

async function replayModel(name: string) {
	const path = join(CASSETTES, `${name}.json`);
	if (RECORD) {
		// Dynamic only: the codex modules (and their auth file) must
		// never load on a replay run — CI has no credentials.
		const { codexModel } = await import("../codex/model.ts");
		const { resolveCodexAuthFile } = await import("../codex/auth.ts");
		return recordedModel({
			path,
			rerecord: RERECORD,
			record: codexModel("gpt-6-luna", resolveCodexAuthFile(undefined).path, fetch, {}),
		});
	}
	return recordedModel({
		path,
		rerecord: RERECORD,
	});
}

interface Rig {
	tool: ReturnType<typeof delegateTool>;
	lifecycle: DelegationLifecycle;
	store: DelegationsStore;
	wakes: string[];
	setAgent(agentStatus: string, seq: number): void;
}

const lifecycles: DelegationLifecycle[] = [];
afterEach(async () => {
	for (const l of lifecycles.splice(0)) await l.stopTicker();
});

function rig(): Rig {
	const home = useHome("goblin-delegrep-");
	const dir = tmpDir("goblin-delegrep-");
	const store = openDelegations(join(dir, "goblin.sqlite"));
	const workspaceDir = join(dir, "workspace");
	mkdirSync(join(workspaceDir, "app"), { recursive: true });

	let agentStatus = "working";
	let seq = 7;
	const agent = (name: string): HcRunInfo => ({
		agent: "codex",
		agent_status: agentStatus,
		name,
		state_change_seq: seq,
		cwd: "/w",
	});
	const hc: HcDelegation = {
		start: (name) => Promise.resolve(agent(name)),
		get: (name) => Promise.resolve(agent(name)),
		prompt: () => Promise.resolve(),
		sendKey: () => Promise.resolve(),
		read: () => Promise.resolve("patched and tested"),
		interrupt: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	};
	const wakes: string[] = [];
	const lifecycle = startDelegationLifecycle(
		{
			delegations: store,
			hc,
			delegationsDir: join(dir, "delegations"),
			homeDir: home,
			wake: (_address, text) => {
				wakes.push(text);
				return true;
			},
			wakeApp: (_conversationId, text) => {
				wakes.push(text);
				return true;
			},
		},
		3_600_000,
	);
	lifecycles.push(lifecycle);
	const tool = delegateTool({
		lifecycle,
		config: { harnesses: { codex: { kind: "codex" }, pi: { kind: "pi" } } },
		pin: () => ({ address: { chatId: -100, threadId: 7 } }),
		workspaceDir,
	});
	return {
		tool,
		lifecycle,
		store,
		wakes,
		setAgent(status, s) {
			agentStatus = status;
			seq = s;
		},
	};
}

async function turn(
	r: Rig,
	cassette: string,
	system: string,
	prompt: string,
) {
	// maxRetries 0 + first-error capture: a stale cassette must surface
	// as StaleRecordingError, not the SDK's NoOutputGenerated wrapper.
	let firstError: unknown;
	const result = streamText({
		model: await replayModel(cassette),
		system,
		prompt,
		tools: toToolSet({ delegate: r.tool }),
		stopWhen: stepCountIs(1),
		providerOptions: { codex: { reasoningEffort: "none" } },
		maxRetries: 0,
		onError: ({ error }) => {
			firstError ??= error;
		},
	});
	let text = "";
	let steps: Awaited<typeof result.steps> = [];
	try {
		text = await result.text;
	} catch (e) {
		firstError ??= e;
	}
	try {
		steps = await result.steps;
	} catch (e) {
		firstError ??= e;
	}
	if (firstError !== undefined) throw firstError;
	return { text, steps };
}

const delegateResults = (steps: Awaited<ReturnType<typeof turn>>["steps"]) =>
	steps.flatMap((s) => s.toolResults).filter((r) => r.toolName === "delegate");

const BASE =
	"You are Goblin, the operator's assistant. Use the delegate tool for work in the operator's repos.";

describe("delegate replay", () => {
	test("T1 repo-work: a codex delegation starts, finishes, and wakes once", async () => {
		const r = rig();
		const { steps } = await turn(
			r,
			"repo-work",
			BASE,
			"Fix the flaky login test in my repo at relative path app. Use the codex harness.",
		);
		const results = delegateResults(steps);
		expect(results).toHaveLength(1);
		expect("error" in (results[0]!.output as Record<string, unknown>)).toBe(false);

		const rows = r.store.list();
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row.cwd.endsWith("/app")).toBe(true);

		r.setAgent("idle", 8);
		await r.lifecycle.tick();
		expect(r.store.get(row.id)!.status).toBe("done");
		expect(r.wakes).toHaveLength(1);
		const wake = r.wakes[0]!;
		const firstLine = wake.split("\n", 1)[0]!;
		expect(firstLine.startsWith(`[delegation: #${row.id} `)).toBe(true);
		expect(firstLine.endsWith("· done]")).toBe(true);
		expect(wake).toContain('<event source="delegation">');
		expect(wake).toContain("patched and tested");
	});

	test("T3 text-only: a plain answer calls no tool and wakes nothing", async () => {
		const r = rig();
		const { text, steps } = await turn(
			r,
			"text-only",
			BASE,
			"Reply with the single word pong. Do not use any tool.",
		);
		expect(steps.flatMap((s) => s.toolCalls)).toHaveLength(0);
		expect(text.length).toBeGreaterThan(0);
		expect(r.store.list()).toEqual([]);
		expect(r.wakes).toEqual([]);
	});

	test.skipIf(RECORD)(
		"T4 stale: a changed prompt fails with the re-record command and writes nothing",
		async () => {
			const r = rig();
			const err = await turn(r, "repo-work", BASE, "Fix something else.").then(
				() => {
					throw new Error("expected turn to reject");
				},
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(StaleRecordingError);
			expect((err as Error).message).toContain(RERECORD);
			expect(r.store.list()).toEqual([]);
		},
	);
});
