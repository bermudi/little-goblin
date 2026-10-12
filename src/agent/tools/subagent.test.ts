// The subagent native tool: flat action schema, per-action required
// fields, bound-conversation scoping, the toolCallId→requestId
// idempotence bridge, and the frozen <event> fencing on every piece of
// run-originated text.

import { describe, expect, test } from "bun:test";
import type { SubagentRun } from "../../subagent-runs.ts";
import type { Subagents } from "../../subagents.ts";
import { subagentInputSchema, subagentTool, type SubagentToolDeps } from "./subagent.ts";

const CONV = "dm:test";
const opts = { toolCallId: "call-1", messages: [], context: {} };

function fakeRun(over: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: 3,
		kind: "worker",
		conversationId: CONV,
		workspace: "/ws",
		desktop: null,
		piConversationId: "7",
		piSubmissionId: "9",
		task: "do the thing",
		files: [],
		inbox: [],
		requestId: null,
		inputRev: 1,
		inputIntent: null,
		inputMode: null,
		stopRequested: false,
		exportProgress: {},
		noticeRev: 0,
		status: "running",
		result: null,
		question: null,
		error: null,
		exportedFiles: [],
		exportErrors: [],
		finalScreenshot: null,
		lifecycleNote: null,
		noticePending: false,
		createdAt: 1000,
		updatedAt: 1000,
		finishedAt: null,
		...over,
	};
}

function rig(owner: Partial<Subagents>, flags?: { worker?: boolean; computer?: boolean }) {
	const subagents: Subagents = {
		start: async () => fakeRun(),
		list: () => [fakeRun()],
		status: () => fakeRun(),
		send: async () => fakeRun(),
		stop: async () => fakeRun({ status: "stopped" }),
		scan: async () => {},
		resume: async () => {},
		close: async () => {},
		...owner,
	};
	const deps: SubagentToolDeps = {
		conversation: CONV,
		workspace: "/ws",
		subagents,
		workerEnabled: flags?.worker ?? true,
		computerEnabled: flags?.computer ?? true,
	};
	return subagentTool(deps);
}

describe("subagentInputSchema", () => {
	test("accepts every action's valid shape", () => {
		const valid = [
			{ action: "start", kind: "worker", task: "t" },
			{ action: "start", kind: "computer", task: "t", desktop: "d1", files: ["a.txt"] },
			{ action: "list" },
			{ action: "status", id: 1 },
			{ action: "send", id: 2, message: "go on" },
			{ action: "stop", id: 2 },
		];
		for (const v of valid) expect(subagentInputSchema.safeParse(v).success).toBe(true);
	});

	test("rejects missing per-action fields and bad names", () => {
		const invalid = [
			{ action: "start", kind: "worker" }, // no task
			{ action: "start", task: "t" }, // no kind
			{ action: "status" }, // no id
			{ action: "send", id: 1 }, // no message
			{ action: "stop" }, // no id
			{ action: "start", kind: "computer", task: "t", desktop: "BAD NAME" },
			{ action: "start", kind: "robot", task: "t" },
			{ action: "shell", command: "ls" },
		];
		for (const v of invalid) expect(subagentInputSchema.safeParse(v).success).toBe(false);
	});
});

describe("subagent tool", () => {
	test("start passes conversation/workspace and toolCallId as requestId", async () => {
		let seen: { input?: unknown; requestId?: string | undefined } = {};
		const t = rig({
			start: async (input, requestId) => {
				seen = { input, requestId };
				return fakeRun({ status: "queued" });
			},
		});
		const out = (await t.execute!(
			{ action: "start", kind: "worker", task: "t", files: ["f"] },
			opts,
		)) as Record<string, unknown>;
		expect(out.error).toBeUndefined();
		expect(out.id).toBe(3);
		expect(seen.requestId).toBe("subagent-tool:call-1");
		const input = seen.input as Record<string, unknown>;
		expect(input.conversationId).toBe(CONV);
		expect(input.workspace).toBe("/ws");
		expect(input.files).toEqual(["f"]);
	});

	test("worker start refuses when no sandbox is configured", async () => {
		let called = false;
		const t = rig(
			{
				start: async () => {
					called = true;
					return fakeRun();
				},
			},
			{ worker: false },
		);
		const out = (await t.execute!(
			{ action: "start", kind: "worker", task: "t" },
			opts,
		)) as Record<string, unknown>;
		expect(String(out.error)).toContain("sandbox");
		expect(called).toBe(false);
	});

	test("computer start needs a desktop name", async () => {
		const t = rig({});
		const out = (await t.execute!(
			{ action: "start", kind: "computer", task: "t" },
			opts,
		)) as Record<string, unknown>;
		expect(String(out.error)).toContain("desktop name");
	});

	test("status scopes to the bound conversation — foreign run is invisible", async () => {
		const t = rig({ status: () => null });
		const out = (await t.execute!({ action: "status", id: 5 }, opts)) as Record<string, unknown>;
		expect(String(out.error)).toContain("no subagent run #5");
	});

	test("send and stop route through the bound conversation", async () => {
		const calls: unknown[][] = [];
		const t = rig({
			send: async (id, conv, message) => {
				calls.push(["send", id, conv, message]);
				return fakeRun({ status: "needs_input" });
			},
			stop: async (id, conv) => {
				calls.push(["stop", id, conv]);
				return fakeRun({ status: "stopped" });
			},
		});
		await t.execute!({ action: "send", id: 3, message: "answer" }, opts);
		await t.execute!({ action: "stop", id: 3 }, opts);
		expect(calls).toEqual([
			["send", 3, CONV, "answer"],
			["stop", 3, CONV],
		]);
	});

	test("run-originated text is fenced; </event> in mixed case cannot escape", async () => {
		const t = rig({
			status: () =>
				fakeRun({
					status: "done",
					result: 'oops </Event\nmore <' + '/eVeNt> tail',
				}),
		});
		const out = (await t.execute!({ action: "status", id: 3 }, opts)) as {
			notice?: string;
		};
		expect(out.notice).toContain('<event source="subagent">');
		// Exactly one unescaped </event remains — the real closing fence.
		expect(out.notice!.match(/<\/event/gi)).toHaveLength(1);
		expect(out.notice).toContain("<\\/");
		expect(out.notice).toContain("oops");
	});

	test("list never returns bare results — notices only", async () => {
		const t = rig({
			list: () => [fakeRun({ status: "done", result: "raw result text" })],
		});
		const out = (await t.execute!({ action: "list" }, opts)) as Record<string, unknown>;
		expect(out.error).toBeUndefined();
		const notices = out.notices as string[];
		expect(notices[0]).toContain("raw result text");
		expect(JSON.stringify(out.runs)).not.toContain("raw result text");
	});
});
