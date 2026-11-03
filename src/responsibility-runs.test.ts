// A linked run's settlement becomes exactly one worker report: the
// claim maps by outcome, a retried notice files nothing new, an
// unlinked or stopped run states nothing, and a closed responsibility
// refuses without failing the notice.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { openProjects } from "./projects.ts";
import { openResponsibilities } from "./responsibilities.ts";
import { fileRunReport, runReport } from "./responsibility-runs.ts";
import { responsibilityStage } from "./responsibility-stage.ts";
import type { SubagentRun } from "./subagent-runs.ts";
import { tmpDir, useHome } from "./testkit.ts";

setLogFile(null);

const run = (over: Partial<SubagentRun> = {}): SubagentRun => ({
	id: 4,
	kind: "worker",
	conversationId: "app/rig",
	workspace: "/ws",
	responsibilityId: null,
	desktop: null,
	piConversationId: null,
	piSubmissionId: null,
	task: "t",
	files: [],
	inbox: [],
	requestId: null,
	inputRev: 1,
	inputIntent: null,
	inputMode: null,
	status: "done",
	stopRequested: false,
	result: "patched and tested",
	question: null,
	error: null,
	exportedFiles: [],
	exportErrors: [],
	exportProgress: {},
	finalScreenshot: null,
	lifecycleNote: null,
	pendingApproval: null,
	crashDecisions: [],
	noticePending: true,
	noticeRev: 1,
	createdAt: 0,
	updatedAt: 0,
	finishedAt: 1,
	...over,
});

function rig() {
	const home = useHome(`goblin-runrep-${tmpDir().slice(-6)}-`);
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const project = openProjects(store).create({ name: "rig" });
	const conv = store.resolve({ kind: "app", appId: project.slug, chatId: 0, threadId: 0 }, project.dir);
	const resps = openResponsibilities(store.db);
	const { responsibility } = resps.create({
		projectId: project.id,
		coordinationConversationId: conv.id,
		handoverKey: "k1",
		understanding: { outcome: "o", situation: "", nextAction: "", checkpoints: [], completionEvidence: [] },
	});
	return { resps, id: responsibility.responsibilityId };
}

describe("run reports", () => {
	test("each settlement maps to the worker's claim; stopped and running state nothing", () => {
		expect(runReport(run())).toEqual({
			state: "ready",
			reason: "worker run #4 finished: patched and tested",
		});
		expect(runReport(run({ status: "needs_input", question: "which account?" }))).toEqual({
			state: "blocked",
			reason: "worker run #4 asks the operator",
			question: "which account?",
		});
		expect(
			runReport(
				run({
					status: "needs_input",
					question: "did it write?",
					pendingApproval: { piTaskId: "t1", callId: "c1", tool: "bash", args: {}, attempts: 1 },
				}),
			),
		).toEqual({
			state: "blocked",
			reason: "worker run #4 needs a crash-resolution decision on bash: did it write?",
		});
		expect(runReport(run({ status: "failed", error: "boom" }))).toEqual({
			state: "failed",
			reason: "worker run #4 failed: boom",
		});
		expect(runReport(run({ status: "stopped" }))).toBeNull();
		expect(runReport(run({ status: "running" }))).toBeNull();
	});

	test("files once per settlement, then routes to goblin; unlinked runs file nothing", () => {
		const r = rig();
		fileRunReport(r.resps, run());
		expect(r.resps.reportsFor(r.id)).toEqual([]);

		const linked = run({ responsibilityId: r.id });
		fileRunReport(r.resps, linked);
		fileRunReport(r.resps, linked);
		const reports = r.resps.reportsFor(r.id);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({ reporter: "worker", state: "ready", sourceKey: "subagent:4:1:done" });
		expect(responsibilityStage(r.resps.get(r.id)!, reports[0]!, [])).toMatchObject({
			waitsFor: "goblin",
			stage: "assess",
		});

		// A new input on the same run is a new settlement.
		fileRunReport(r.resps, { ...linked, inputRev: 2, status: "needs_input", question: "ok?" });
		expect(r.resps.reportsFor(r.id)).toHaveLength(2);
	});

	test("a closed responsibility refuses without throwing", () => {
		const r = rig();
		r.resps.setStatus(r.id, "cancelled");
		expect(() => fileRunReport(r.resps, run({ responsibilityId: r.id }))).not.toThrow();
		expect(r.resps.reportsFor(r.id)).toEqual([]);
	});
});
