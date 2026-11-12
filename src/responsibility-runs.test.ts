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
import {
	delegationReport,
	fileDelegationReport,
	fileRunReport,
	runReport,
} from "./responsibility-runs.ts";
import type { Delegation } from "./delegations.ts";
import { responsibilityStage } from "./responsibility-stage.ts";
import type { SubagentRun } from "./subagent-runs.ts";
import { tmpDir, useHome } from "./testkit.ts";
import { prReadinessFixture } from "./test-helpers/pr-readiness.ts";

setLogFile(null);

const run = (over: Partial<SubagentRun> = {}): SubagentRun => ({
	id: 4,
	kind: "worker",
	conversationId: "app/rig",
	workspace: "/ws",
	responsibilityId: null,
	responsibilityRevision: null,
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
	const conv = store.resolve(
		{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
		project.dir,
	);
	const resps = openResponsibilities(store.db);
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
	return { resps, id: responsibility.responsibilityId };
}

describe("run reports", () => {
	test("each settlement maps to the worker's claim; stopped and running state nothing", () => {
		expect(runReport(run())).toEqual({
			state: "ready",
			reason: "worker run #4 finished: patched and tested",
		});
		// Exported files ride as artifacts the feed links, not reason text.
		expect(runReport(run({ exportedFiles: ["/ws/out/report.md", "/ws/out/fix.patch"] }))).toEqual({
			state: "ready",
			reason: "worker run #4 finished: patched and tested",
			artifacts: [
				{ title: "report.md", ref: "/ws/out/report.md" },
				{ title: "fix.patch", ref: "/ws/out/fix.patch" },
			],
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
		expect(reports[0]).toMatchObject({
			reporter: "worker",
			state: "ready",
			sourceKey: "subagent:4:1:done",
		});
		expect(responsibilityStage(r.resps.get(r.id)!, reports[0]!, [])).toMatchObject({
			waitsFor: "goblin",
			stage: "assess",
		});

		// A new input on the same run is a new settlement.
		fileRunReport(r.resps, { ...linked, inputRev: 2, status: "needs_input", question: "ok?" });
		expect(r.resps.reportsFor(r.id)).toHaveLength(2);
	});

	test("a claim from before a correction is not current", () => {
		const r = rig();
		const before = r.resps.get(r.id)!;
		r.resps.revise(r.id, before.understanding);
		fileRunReport(
			r.resps,
			run({
				responsibilityId: r.id,
				responsibilityRevision: before.revision,
				status: "needs_input",
				question: "which branch?",
			}),
		);
		const latest = r.resps.latestReport(r.id)!;
		expect(latest.revision).toBe(before.revision);
		expect(responsibilityStage(r.resps.get(r.id)!, latest, []).waitsFor).toBe("goblin");
	});

	test("a report that can never file does not throw, so the notice still wakes", () => {
		const r = rig();
		expect(() => fileRunReport(r.resps, run({ responsibilityId: "gone" }))).not.toThrow();
		const blank = run({ responsibilityId: r.id, exportedFiles: ["/out/   "] });
		expect(() => fileRunReport(r.resps, blank)).not.toThrow();
		expect(r.resps.reportsFor(r.id)).toEqual([]);
		// Over the question bound: clipped, not refused.
		fileRunReport(
			r.resps,
			run({ responsibilityId: r.id, status: "needs_input", question: "q".repeat(3000) }),
		);
		expect(r.resps.latestReport(r.id)!.question).toHaveLength(2000);
	});

	test("the store refuses an invalid report before it can poison reads", () => {
		const r = rig();
		expect(() =>
			r.resps.report(
				r.id,
				{ state: "progress", reason: "x", artifacts: [{ title: "   ", ref: "y" }] },
				"goblin",
			),
		).toThrow();
		expect(r.resps.reportsFor(r.id)).toEqual([]);
	});

	test("a closed responsibility refuses without throwing", () => {
		const r = rig();
		r.resps.setStatus(r.id, "cancelled");
		expect(() => fileRunReport(r.resps, run({ responsibilityId: r.id }))).not.toThrow();
		expect(r.resps.reportsFor(r.id)).toEqual([]);
	});
});

const delegation = (over: Partial<Delegation> = {}): Delegation => ({
	id: 9,
	name: "fix it",
	harness: "codex",
	role: "default",
	issue: null,
	readiness: null,
	readinessNotifiedKey: null,
	readinessVersion: 0,
	cwd: "/w",
	task: "t",
	chatId: 0,
	threadId: null,
	appConversation: "app/rig",
	agentName: "g9-fix-it",
	workspaceId: "w1",
	paneId: "w1:p1",
	status: "running",
	target: null,
	baselineSeq: 3,
	promptedAt: "2026-11-06T00:00:00.000Z",
	promptPending: false,
	responsibilityId: null,
	responsibilityRevision: null,
	createdAt: "2026-11-06T00:00:00.000Z",
	finishedAt: null,
	...over,
});

describe("delegation reports", () => {
	test("observed readiness is sourced evidence, not the lead's claim; retries are idempotent", () => {
		const { resps, id } = rig();
		const d = delegation({ responsibilityId: id, responsibilityRevision: 1, role: "lead", readinessVersion: 1 });
		const pending = prReadinessFixture();
		fileDelegationReport(resps, d, "done", "Ready to merge!", pending);
		fileDelegationReport(resps, d, "done", "Ready to merge!", pending);
		expect(resps.reportsFor(id)).toHaveLength(1);
		const first = resps.reportsFor(id)[0]!;
		expect(first.state).toBe("waiting");
		expect(first.reason).toStartWith("Not ready: CI is pending");
		expect(first.evidence).toHaveLength(4);
		expect(first.evidence[2]).toMatchObject({
			item: "Verifier verdict", ref: pending.result.verifier!.source,
			checked: expect.stringContaining(pending.result.head.sha),
		});
		fileDelegationReport(resps, { ...d, readinessVersion: 2 }, "done", "Ready!", prReadinessFixture("green"));
		fileDelegationReport(resps, { ...d, readinessVersion: 3 }, "done", "Still ready!", pending);
		expect(resps.reportsFor(id).map((r) => r.state)).toEqual(["waiting", "ready", "waiting"]);
		expect(resps.get(id)?.status).toBe("active");
	});

	test("stale verification blocks even when the lead claims done and CI is green", () => {
		const observation = prReadinessFixture("green");
		observation.result.verifier!.sha = "b".repeat(40);
		observation.result.ready = false;
		observation.result.reasons = ["Verifier verdict is for an older or different SHA"];
		expect(delegationReport(delegation(), "done", "Everything passed", observation)).toMatchObject({
			state: "blocked", reason: expect.stringContaining("older or different SHA"),
		});
	});

	test("each verdict maps to the agent's claim; a blocked agent asks no question", () => {
		expect(delegationReport(delegation(), "done", "patched")).toEqual({
			state: "ready",
			reason: "delegation #9 fix it finished: patched",
		});
		expect(delegationReport(delegation(), "needs input", "dialog")).toEqual({
			state: "blocked",
			reason: "delegation #9 fix it needs input: dialog",
		});
		expect(delegationReport(delegation(), "failed", "gone")).toEqual({
			state: "failed",
			reason: "delegation #9 fix it failed: gone",
		});
	});

	test("an unlinked delegation states nothing", () => {
		const { resps, id } = rig();
		fileDelegationReport(resps, delegation(), "done", "patched");
		expect(resps.reportsFor(id)).toEqual([]);
	});

	test("a retried notice files once; a later dialog on the same prompt files again", () => {
		const { resps, id } = rig();
		const d = delegation({ responsibilityId: id, responsibilityRevision: 1 });
		fileDelegationReport(resps, d, "needs input", "first dialog");
		fileDelegationReport(resps, d, "needs input", "first dialog");
		expect(resps.reportsFor(id)).toHaveLength(1);
		fileDelegationReport(resps, { ...d, baselineSeq: 5 }, "needs input", "second dialog");
		expect(resps.reportsFor(id)).toHaveLength(2);
		fileDelegationReport(
			resps,
			{ ...d, promptedAt: "2026-11-06T01:00:00.000Z" },
			"done",
			"follow-up done",
		);
		expect(resps.reportsFor(id)).toHaveLength(3);
	});

	test("a blocked agent waits for goblin, not the operator", () => {
		const { resps, id } = rig();
		fileDelegationReport(resps, delegation({ responsibilityId: id }), "needs input", "dialog");
		const resp = resps.get(id)!;
		const [latest] = resps.reportsFor(id);
		expect(responsibilityStage(resp, latest ?? null, []).waitsFor).toBe("goblin");
	});

	test("a closed responsibility refuses without failing the notice", () => {
		const { resps, id } = rig();
		resps.setStatus(id, "cancelled");
		const d = delegation({ responsibilityId: id });
		expect(() => fileDelegationReport(resps, d, "done", "patched")).not.toThrow();
		expect(resps.reportsFor(id)).toEqual([]);
	});

	test("a gone responsibility logs and does not throw", () => {
		const { resps } = rig();
		const d = delegation({ responsibilityId: "nope" });
		expect(() => fileDelegationReport(resps, d, "done", "patched")).not.toThrow();
	});
});
