
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { openSubagentRuns, type SubagentRuns } from "../subagent-runs.ts";
import { SubagentError } from "./errors.ts";
import { makeApprovalGate, type ApprovalGateDeps } from "./approval-gate.ts";
import type { RunOutcomeBody } from "./run-doc.ts";

const dirs: string[] = [];
const stores: SubagentRuns[] = [];
afterEach(() => {
	for (const s of stores) s.close();
	stores.length = 0;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

type LeaseRow = {
	state: "absent" | "claimed" | "decided" | "done";
	attempts: number | null;
	decision: JsonValue | null;
	result: JsonValue | null;
};

function fakeApi(seed: LeaseRow | undefined, ids?: { conversationId?: number; taskId?: number }) {
	const committed: LeaseRow[] = [];
	const output: string[] = [];
	const api = {
		taskId: ids?.taskId ?? 1,
		conversationId: ids?.conversationId ?? 1,
		callId: "call-1",
		output(chunk: string | Uint8Array) {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		},
		diagnostic() {},
		async details() {},
		async snapshot() {
			return seed;
		},
		async snapshotAsOf() {
			return seed;
		},
		async commit(change: (tx: unknown) => unknown) {
			const draft: LeaseRow =
				seed === undefined
					? { state: "absent", attempts: null, decision: null, result: null }
					: { ...seed };
			const tx = { doc: async () => draft };
			const result = await change(tx);
			seed = { ...draft };
			committed.push({ ...draft });
			return result;
		},
	} as unknown as ToolExecutionApi;
	return { api, committed, output };
}

function rig(api: ToolExecutionApi, row?: { piConversationId?: string; stopRequested?: boolean }) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-gate-"));
	dirs.push(dir);
	const runs = openSubagentRuns(join(dir, "runs.sqlite"));
	stores.push(runs);
	const created = runs.create({
		kind: "worker",
		conversationId: "dm:1",
		workspace: "/w",
		task: "t",
	});
	const live = runs.update(created.id, {
		status: "running",
		piConversationId: row?.piConversationId ?? "1",
		stopRequested: row?.stopRequested ?? false,
	});
	const calls = {
		outcomes: [] as RunOutcomeBody[],
		notified: 0,
		released: 0,
		drains: 0,
		aborted: 0,
	};
	const deps: ApprovalGateDeps = {
		runs,
		rowForConversation: (pi) => (live.piConversationId === pi ? live : null),
		recordOutcome: async (_api, outcome) => {
			calls.outcomes.push(outcome);
		},
		notify: () => {
			calls.notified += 1;
		},
		releaseLeases: () => {
			calls.released += 1;
		},
		scheduleDrain: () => {
			calls.drains += 1;
		},
		abortConversation: async () => {
			calls.aborted += 1;
		},
	};
	const gate = makeApprovalGate(deps);
	return { runs, live, calls, gate };
}

function fakeTool(inner?: (args: unknown) => Promise<ToolExecutionResult>): ToolRegistration & {
	executions: number;
} {
	const tool = {
		name: "side_effect_tool",
		executions: 0,
		execute: async () => {
			tool.executions += 1;
			return (
				(await inner?.({})) ?? {
					output: [{ type: "text" as const, text: "observed" }],
				}
			);
		},
	} as unknown as ToolRegistration & { executions: number };
	return tool;
}

const DECISION = {
	kind: "record-result" as const,
	result: "the payment landed",
	evidence: "ledger row 7",
	reasoning: "idempotent key present",
	decidedBy: "goblin" as const,
};

describe("crash-approval lease", () => {
	test("a fresh call claims generation 1, executes once, and settles the effective result", async () => {
		const { api, committed } = fakeApi(undefined);
		const { gate } = rig(api);
		const base = fakeTool();
		const tool = gate.withGate(base);
		const result = await tool.execute({} as never, api, BACKGROUND_CONTEXT);
		expect(result.output?.[0]).toMatchObject({ text: "observed" });
		expect(base.executions).toBe(1);
		expect(committed.map((c) => c.state)).toEqual(["claimed", "done"]);
		expect(committed[0]?.attempts).toBe(1);
		expect(committed[1]?.result).toMatchObject({
			output: [{ type: "text", text: "observed" }],
		});
	});

	test("a done lease replays the recorded result — the tool never re-executes", async () => {
		const stored: ToolExecutionResult = {
			output: [{ type: "text" as const, text: "committed earlier" }],
		};
		const { api } = fakeApi({
			state: "done",
			attempts: null,
			decision: null,
			result: stored as unknown as JsonValue,
		});
		const { gate } = rig(api);
		const base = fakeTool();
		const tool = gate.withGate(base);
		const result = await tool.execute({} as never, api, BACKGROUND_CONTEXT);
		expect(result.output?.[0]).toMatchObject({ text: "committed earlier" });
		expect(base.executions).toBe(0);
	});

	test("a claimed lease parks; a record-result verdict commits decided→done and never re-executes", async () => {
		const { api, committed } = fakeApi({
			state: "claimed",
			attempts: 1,
			decision: null,
			result: null,
		});
		const { gate, calls, live, runs } = rig(api);
		const base = fakeTool();
		const tool = gate.withGate(base);
		const pending = tool.execute({} as never, api, BACKGROUND_CONTEXT);
		await Bun.sleep(20);
		const parked = runs.get(live.id);
		expect(parked?.status).toBe("needs_input");
		expect(parked?.pendingApproval?.tool).toBe("side_effect_tool");
		expect(calls.released).toBe(1);
		expect(calls.notified).toBe(1);
		expect(calls.drains).toBe(1);
		gate.takeWaiter(gate.approvalKey("1", "1"))?.(DECISION);
		const result = await pending;
		expect(result.isError).toBe(true);
		expect((result.details as { crashResolution?: unknown })?.crashResolution).toMatchObject({
			decidedBy: "goblin",
			outcome: "unverified",
		});
		expect(base.executions).toBe(0);
		expect(committed.map((c) => c.state)).toEqual(["decided", "done"]);
	});

	test("authorize-retry admits exactly one re-execution under a raised generation", async () => {
		const { api, committed } = fakeApi({
			state: "claimed",
			attempts: 2,
			decision: null,
			result: null,
		});
		const { gate } = rig(api);
		gate.storeDecision(gate.approvalKey("1", "1"), {
			kind: "authorize-retry",
			evidence: "no trace of the effect",
			reasoning: "the call is idempotent",
		});
		const base = fakeTool();
		const tool = gate.withGate(base);
		const result = await tool.execute({} as never, api, BACKGROUND_CONTEXT);
		expect(base.executions).toBe(1);
		expect(result.output?.[0]).toMatchObject({ text: "observed" });
		expect(committed.map((c) => c.state)).toEqual(["decided", "claimed", "done"]);
		expect(committed[1]?.attempts).toBe(3);
	});

	test("abandon records the outcome and terminates — no re-execution", async () => {
		const { api } = fakeApi({ state: "claimed", attempts: 1, decision: null, result: null });
		const { gate, calls } = rig(api);
		gate.storeDecision(gate.approvalKey("1", "1"), {
			kind: "abandon",
			evidence: "unknown",
			reasoning: "unsafe to retry",
		});
		const base = fakeTool();
		const tool = gate.withGate(base);
		const result = await tool.execute({} as never, api, BACKGROUND_CONTEXT);
		expect(calls.outcomes[0]?.kind).toBe("aborted");
		expect(result.control?.terminate).toBe(true);
		expect(result.isError).toBe(true);
		expect(base.executions).toBe(0);
	});

	test("the park refuses a run that is already stopping", async () => {
		const { api } = fakeApi({ state: "claimed", attempts: 1, decision: null, result: null });
		const { gate } = rig(api, { stopRequested: true });
		const base = fakeTool();
		const tool = gate.withGate(base);
		await expect(tool.execute({} as never, api, BACKGROUND_CONTEXT)).rejects.toThrow(SubagentError);
		expect(base.executions).toBe(0);
	});
});
