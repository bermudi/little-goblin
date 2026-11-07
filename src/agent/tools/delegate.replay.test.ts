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
import { openStore } from "../../conversation.ts";
import { openDelegations, type DelegationsStore } from "../../delegations.ts";
import {
	startDelegationLifecycle,
	type DelegationLifecycle,
	type DelegationTargetDeps,
} from "../../delegation-lifecycle.ts";
import type { AgentInfo, Herdr } from "../../herdr.ts";
import { openProjects } from "../../projects.ts";
import { openResponsibilities, type ResponsibilityStore } from "../../responsibilities.ts";
import { fileDelegationReport } from "../../responsibility-runs.ts";
import { responsibilityStage } from "../../responsibility-stage.ts";
import { recordedModel, StaleRecordingError } from "../../testkit/model-replay.ts";
import { tmpDir, useHome } from "../../testkit.ts";
import { delegateTool } from "./delegate.ts";

const RERECORD = "GOBLIN_MODEL_RECORD=1 bun test src/agent/tools/delegate.replay.test.ts";
const RECORD = process.env.GOBLIN_MODEL_RECORD === "1";
const CASSETTES = join(import.meta.dir, "fixtures", "delegate-replay");

async function replayModel(name: string, substitute?: Record<string, string>) {
	const path = join(CASSETTES, `${name}.json`);
	if (RECORD) {
		// Dynamic only: the codex modules (and their auth file) must
		// never load on a replay run — CI has no credentials.
		const { CodexLanguageModel } = await import("../codex/model.ts");
		const { resolveCodexAuthFile } = await import("../codex/auth.ts");
		return recordedModel({
			path,
			rerecord: RERECORD,
			...(substitute === undefined ? {} : { substitute }),
			record: new CodexLanguageModel("gpt-6-luna", resolveCodexAuthFile(undefined).path),
		});
	}
	return recordedModel({
		path,
		rerecord: RERECORD,
		...(substitute === undefined ? {} : { substitute }),
	});
}

interface Rig {
	tool: ReturnType<typeof delegateTool>;
	lifecycle: DelegationLifecycle;
	store: DelegationsStore;
	resps: ResponsibilityStore;
	responsibilityId: string;
	wakes: string[];
	setAgent(agentStatus: string, seq: number): void;
}

const lifecycles: DelegationLifecycle[] = [];
afterEach(async () => {
	for (const l of lifecycles.splice(0)) await l.stopTicker();
});

function rig(): Rig {
	const home = useHome("goblin-delegrep-");
	mkdirSync(join(home, "state"), { recursive: true });
	const convStore = openStore(join(home, "state", "goblin.sqlite"));
	const project = openProjects(convStore).create({ name: "rig" });
	const conv = convStore.resolve(
		{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
		project.dir,
	);
	const resps = openResponsibilities(convStore.db);
	const { responsibility } = resps.create({
		projectId: project.id,
		coordinationConversationId: conv.id,
		handoverKey: "k1",
		understanding: {
			outcome: "o",
			situation: "",
			nextAction: "",
			checkpoints: [],
			completionEvidence: [],
		},
	});

	const dir = tmpDir("goblin-delegrep-");
	const store = openDelegations(join(dir, "goblin.sqlite"));
	const workspaceDir = join(dir, "workspace");
	mkdirSync(join(workspaceDir, "app"), { recursive: true });

	let agentStatus = "working";
	let seq = 7;
	const agent = (name: string): AgentInfo => ({
		agent: "codex",
		agent_status: agentStatus,
		name,
		pane_id: "w1:p1",
		workspace_id: "w1",
		state_change_seq: seq,
		cwd: "/w",
	});
	const herdr: Herdr = {
		createWorkspace: () => Promise.resolve({ workspaceId: "w1", paneId: "w1:p1", cwd: "/w" }),
		startAgent: (name) => Promise.resolve(agent(name)),
		get: (name) => Promise.resolve(agent(name)),
		prompt: () => Promise.resolve(),
		sendKey: () => Promise.resolve(),
		readAgent: () => Promise.resolve("patched and tested"),
		readPane: () => Promise.resolve("pane screen"),
		interrupt: () => Promise.resolve(),
		closeWorkspace: () => Promise.resolve(),
		paneRun: () => Promise.resolve(),
		paneWaitOutput: () => Promise.resolve(),
	};
	const wakes: string[] = [];
	const targets = new Map<string, DelegationTargetDeps>();
	const lifecycle = startDelegationLifecycle(
		{
			delegations: store,
			herdr,
			targets,
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
			settled: (d, verdict, body) => fileDelegationReport(resps, d, verdict, body),
			responsibilityRevision: (id) => resps.get(id)?.revision ?? null,
		},
		3_600_000,
	);
	lifecycles.push(lifecycle);
	const tool = delegateTool({
		lifecycle,
		config: { harnesses: { codex: { kind: "codex" }, pi: { kind: "pi" } } },
		pin: () => ({ address: { chatId: -100, threadId: 7 } }),
		workspaceDir,
		checkResponsibility: (id) =>
			resps.get(id) === null ? `responsibility ${id} not found in this project` : null,
	});
	return {
		tool,
		lifecycle,
		store,
		resps,
		responsibilityId: responsibility.responsibilityId,
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
	substitute?: Record<string, string>,
) {
	// maxRetries 0 + first-error capture: a stale cassette must surface
	// as StaleRecordingError, not the SDK's NoOutputGenerated wrapper.
	let firstError: unknown;
	const result = streamText({
		model: await replayModel(cassette, substitute),
		system,
		prompt,
		tools: { delegate: r.tool },
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
		expect(row.responsibilityId).toBeNull();

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
		for (const resp of r.resps.open()) {
			expect(r.resps.reportsFor(resp.responsibilityId)).toEqual([]);
		}
	});

	test("T2 linked: a responsibility-linked delegation files one worker report", async () => {
		const r = rig();
		const revision = r.resps.get(r.responsibilityId)!.revision;
		const { steps } = await turn(
			r,
			"linked",
			`${BASE} This is a project conversation. Active responsibility: r-12 (fix the failing build in the repo at relative path app).`,
			"Start fixing the failing build for r-12 in the repo at relative path app. Use the codex harness.",
			{ "r-12": r.responsibilityId },
		);
		const results = delegateResults(steps);
		expect(results).toHaveLength(1);
		expect("error" in (results[0]!.output as Record<string, unknown>)).toBe(false);

		const rows = r.store.list();
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row.responsibilityId).toBe(r.responsibilityId);
		expect(row.responsibilityRevision).toBe(revision);

		r.setAgent("idle", 8);
		await r.lifecycle.tick();
		expect(r.store.get(row.id)!.status).toBe("done");
		expect(r.wakes).toHaveLength(1);
		const reports = r.resps.reportsFor(r.responsibilityId);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({ reporter: "worker", state: "ready" });
		expect(reports[0]!.reason).toContain("patched and tested");
		expect(responsibilityStage(r.resps.get(r.responsibilityId)!, reports[0]!, []).waitsFor).toBe(
			"goblin",
		);
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
