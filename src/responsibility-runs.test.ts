// A linked delegation's settlement becomes exactly one worker report:
// the claim maps by outcome, a retried notice files nothing new, an
// unlinked delegation states nothing, and a closed responsibility
// refuses without failing the notice.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { openProjects } from "./projects.ts";
import { openResponsibilities } from "./responsibilities.ts";
import { delegationReport, fileDelegationReport } from "./responsibility-runs.ts";
import type { Delegation } from "./delegations.ts";
import { responsibilityStage } from "./responsibility-stage.ts";
import { tmpDir, useHome } from "./testkit.ts";
import { prReadinessFixture } from "./test-helpers/pr-readiness.ts";

setLogFile(null);

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

const delegation = (over: Partial<Delegation> = {}): Delegation => ({
	id: 9,
	name: "fix it",
	harness: "codex",
	role: "default",
	issue: null,
	readiness: null,
	readinessNotifiedKey: null,
	readinessVersion: 0,
	readinessPendingVerdict: null,
	cwd: "/w",
	task: "t",
	chatId: 0,
	threadId: null,
	appConversation: "app/rig",
	agentName: "g1-rig",
	workspaceId: "w1",
	paneId: "w1:p1",
	status: "running",
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
		expect(delegationReport(delegation(), "stopped", "interrupted")).toEqual({
			state: "blocked",
			reason: "delegation #9 fix it stopped by the operator: interrupted",
		});
	});

	test("a stopped lead stays blocked even when its PR readiness facts pass", () => {
		const { resps, id } = rig();
		const d = delegation({
			responsibilityId: id, responsibilityRevision: 1, role: "lead", readinessVersion: 1,
		});
		fileDelegationReport(resps, d, "stopped", "operator stopped it", prReadinessFixture("green"));
		const [report] = resps.reportsFor(id);
		expect(report).toMatchObject({
			state: "blocked", reason: expect.stringContaining("operator stopped it"),
		});
		expect(report?.evidence).toHaveLength(4);
		expect(responsibilityStage(resps.get(id)!, report ?? null, []).waitsFor).toBe("goblin");
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
