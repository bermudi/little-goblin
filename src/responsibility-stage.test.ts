// The stage table, row by row — first match wins. Each row is a
// claim the feed, Attention and the scheduler all rely on.

import { describe, expect, test } from "bun:test";
import type { ResponsibilityReport } from "./responsibility-reports.ts";
import { responsibilityStage } from "./responsibility-stage.ts";

const report = (over: Partial<ResponsibilityReport> = {}): ResponsibilityReport => ({
	reportId: 1,
	responsibilityId: "r1",
	revision: 2,
	reporter: "goblin",
	state: "progress",
	reason: "tests running",
	question: null,
	resumeWhen: null,
	evidence: [],
	createdAt: "2026-11-02T00:00:00.000Z",
	...over,
});
const active = { status: "active" as const, revision: 2 };
const uncertain = [{ operationId: "op-1", state: "uncertain" as const }];

describe("responsibility stage", () => {
	test("closed: a closing report names how it ended", () => {
		expect(
			responsibilityStage(
				{ status: "completed", revision: 2 },
				report({ state: "dropped", reason: "superseded" }),
				uncertain,
			),
		).toEqual({ waitsFor: "nobody", stage: "closed", reason: "dropped: superseded" });
		expect(responsibilityStage({ status: "cancelled", revision: 2 }, null, [])).toMatchObject({
			stage: "closed",
			reason: "responsibility cancelled",
		});
	});

	test("paused outranks every report and send", () => {
		expect(
			responsibilityStage(
				{ status: "paused", revision: 2 },
				report({ state: "blocked" }),
				uncertain,
			),
		).toMatchObject({ waitsFor: "operator", stage: "paused" });
	});

	test("an unconfirmed send is goblin's to reconcile, before any question", () => {
		expect(responsibilityStage(active, report({ question: "which branch?" }), uncertain)).toEqual({
			waitsFor: "goblin",
			stage: "delivery-uncertain",
			reason: "send op-1 delivery unconfirmed — inspect and reconcile",
		});
		expect(
			responsibilityStage(active, null, [{ operationId: "op-2", state: "acknowledged" }]).stage,
		).toBe("working");
	});

	test("a question waits on the operator whatever the state", () => {
		expect(
			responsibilityStage(active, report({ state: "progress", question: "which branch?" }), []),
		).toEqual({
			waitsFor: "operator",
			stage: "question",
			reason: "which branch?",
		});
	});

	for (const [state, stage] of [
		["ready", "review"],
		["blocked", "blocked"],
		["failed", "failed"],
	] as const) {
		test(`${state} waits on the operator as ${stage}`, () => {
			expect(responsibilityStage(active, report({ state, reason: "why" }), [])).toEqual({
				waitsFor: "operator",
				stage,
				reason: "why",
			});
		});
	}

	test("waiting on an external condition waits on nobody and names it", () => {
		expect(
			responsibilityStage(
				active,
				report({ state: "waiting", resumeWhen: "CI run 42 finishes" }),
				[],
			),
		).toEqual({ waitsFor: "nobody", stage: "waiting", reason: "CI run 42 finishes" });
	});

	test("a correction since the report answers it — back to the worker", () => {
		expect(
			responsibilityStage(
				{ status: "active", revision: 3 },
				report({ state: "blocked", question: "?" }),
				[],
			),
		).toEqual({
			waitsFor: "worker",
			stage: "working",
			reason: "operator corrected since the last report",
		});
	});

	test("otherwise working, with the latest progress or its absence", () => {
		expect(responsibilityStage(active, report(), [])).toMatchObject({
			waitsFor: "worker",
			reason: "tests running",
		});
		expect(responsibilityStage(active, null, [])).toMatchObject({ reason: "no report yet" });
		expect(responsibilityStage(active, report({ state: "done" }), [])).toMatchObject({
			stage: "working",
			reason: "resumed after done",
		});
	});
});
