// The stage table, row by row — first match wins. Each row is a claim the
// feed, Attention and the scheduler all rely on.
import { describe, expect, test } from "bun:test";
import type { ResponsibilityReport } from "./responsibility-reports.ts";
import { openObligations, responsibilityStage } from "./responsibility-stage.ts";

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
	purpose: "status",
	artifacts: [],
	sourceKey: null,
	createdAt: "2026-11-02T00:00:00.000Z",
	...over,
});
const active = { status: "active" as const, revision: 2 };
const uncertain = [{ operationId: "op-1", state: "uncertain" as const }];

describe("responsibility stage", () => {
	test("T1: a newer status report does not hide an open question", () => {
		const question = report({ reportId: 1, question: "Which branch?" });
		const newer = report({ reportId: 2, reason: "Still working" });
		expect(responsibilityStage(active, { status: newer, open: [question] }, [])).toMatchObject({
			stage: "question",
			reason: "Which branch?",
			since: { reportId: 1, createdAt: question.createdAt },
		});
	});

	test("T2: worker claims remain open and the oldest claim leads assessment", () => {
		const first = report({ reportId: 1, reporter: "worker", reason: "worker one claim" });
		const second = report({ reportId: 2, reporter: "worker", reason: "worker two claim" });
		expect(openObligations(active, [first, second])).toHaveLength(2);
		expect(responsibilityStage(active, { status: null, open: [first, second] }, [])).toMatchObject({
			stage: "assess",
			reason: "worker one claim (+1 more unassessed worker claims)",
			since: { reportId: 1 },
		});
	});

	test("closed: a closing snapshot names how it ended", () => {
		expect(responsibilityStage(
			{ status: "completed", revision: 2 },
			{ status: report({ state: "dropped", reason: "superseded" }), open: [] },
			uncertain,
		))
			.toMatchObject({ waitsFor: "nobody", stage: "closed", reason: "dropped: superseded" });
		expect(responsibilityStage({ status: "cancelled", revision: 2 }, { status: null, open: [] }, []))
			.toMatchObject({ stage: "closed", reason: "responsibility cancelled" });
	});

	test("paused outranks reports and does not create a reminder anchor", () => {
		expect(responsibilityStage({ status: "paused", revision: 2 }, { status: report({ state: "blocked" }), open: [] }, uncertain))
			.toMatchObject({ waitsFor: "operator", stage: "paused", since: null });
	});

	test("an uncertain send belongs to goblin before an open question", () => {
		expect(responsibilityStage(
			active,
			{ status: report(), open: [report({ reportId: 2, question: "which branch?" })] },
			uncertain,
		))
			.toMatchObject({ waitsFor: "goblin", stage: "delivery-uncertain", since: null });
	});

	test("current question takes priority over snapshot", () => {
		const question = report({ question: "which branch?" });
		expect(responsibilityStage(active, { status: report({ state: "blocked" }), open: [question] }, []))
			.toMatchObject({ waitsFor: "operator", stage: "question", reason: "which branch?" });
	});

	test("a worker question waits on the operator even when the report is blocked", () => {
		const question = report({
			reportId: 7,
			reporter: "worker",
			state: "blocked",
			question: "Which account?",
		});
		expect(responsibilityStage(active, { status: null, open: [question] }, [])).toEqual({
			waitsFor: "operator",
			stage: "question",
			reason: "Which account?",
			since: { reportId: 7, createdAt: question.createdAt },
		});
	});

	test.each(["ready", "failed", "blocked"] as const)(
		"a worker %s claim waits on goblin to assess",
		(state) => {
			const claim = report({
				reportId: 8,
				reporter: "worker",
				state,
				reason: `${state} claim`,
			});
			expect(responsibilityStage(active, { status: null, open: [claim] }, [])).toEqual({
				waitsFor: "goblin",
				stage: "assess",
				reason: `${state} claim`,
				since: { reportId: 8, createdAt: claim.createdAt },
			});
		},
	);

	test("an acknowledged operation does not stop working stage", () => {
		const snapshot = report({ reportId: 9, state: "progress" });
		expect(responsibilityStage(active, { status: snapshot, open: [] }, [
			{ operationId: "op-2", state: "acknowledged" },
		])).toEqual({
			waitsFor: "worker",
			stage: "working",
			reason: "tests running",
			since: { reportId: 9, createdAt: snapshot.createdAt },
		});
	});

	test("a progress snapshot remains working with its reason", () => {
		const snapshot = report({ reportId: 10, state: "progress" });
		expect(responsibilityStage(active, { status: snapshot, open: [] }, [])).toEqual({
			waitsFor: "worker",
			stage: "working",
			reason: "tests running",
			since: { reportId: 10, createdAt: snapshot.createdAt },
		});
	});

	test("snapshot stages retain their behavior and since identity", () => {
		for (const [state, name] of [["ready", "review"], ["blocked", "blocked"], ["failed", "failed"]] as const) {
			const snapshot = report({ state, reason: "why" });
			expect(responsibilityStage(active, { status: snapshot, open: [] }, []))
				.toMatchObject({ waitsFor: "operator", stage: name, reason: "why", since: { reportId: 1 } });
		}
		expect(responsibilityStage(active, { status: report({ state: "waiting", resumeWhen: "CI finishes" }), open: [] }, []))
			.toMatchObject({ waitsFor: "nobody", stage: "waiting", reason: "CI finishes" });
	});

	test("T6: correction makes a question stale, but a current question still wins", () => {
		const stale = report({ reportId: 1, question: "old question", revision: 1 });
		expect(responsibilityStage(active, { status: report({ revision: 1 }), open: [stale] }, []))
			.toMatchObject({ stage: "assess", reason: "operator corrected since the question — re-ask or resolve: old question" });
		const current = report({ reportId: 2, question: "new question" });
		expect(responsibilityStage(active, { status: report(), open: [stale, current] }, []))
			.toMatchObject({ stage: "question", reason: "new question" });
	});

	test("an older snapshot needs assessment; no snapshot means working", () => {
		expect(responsibilityStage({ status: "active", revision: 3 }, { status: report({ revision: 2 }), open: [] }, []))
			.toMatchObject({ waitsFor: "goblin", stage: "assess", reason: "operator corrected since the last report" });
		expect(responsibilityStage(active, { status: null, open: [] }, []))
			.toMatchObject({ waitsFor: "worker", stage: "working", reason: "no report yet", since: null });
		expect(responsibilityStage(active, { status: report({ state: "done" }), open: [] }, []))
			.toMatchObject({ stage: "working", reason: "resumed after done" });
	});
});
