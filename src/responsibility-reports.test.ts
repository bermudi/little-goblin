// Reports on the durable store: completion needs evidence for every
// completionEvidence item, closing reports close atomically, a closed
// responsibility refuses, and legacy waiting/blocked statuses migrate
// into reports without losing the operator-facing stage.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { openProjects } from "./projects.ts";
import { openResponsibilities } from "./responsibilities.ts";
import { reportInputSchema } from "./responsibility-reports.ts";
import { responsibilityStage } from "./responsibility-stage.ts";
import { tmpDir, useHome } from "./testkit.ts";

setLogFile(null);

function rig() {
	const home = useHome(`goblin-reports-${tmpDir().slice(-6)}-`);
	mkdirSync(join(home, "state"), { recursive: true });
	const dbPath = join(home, "state", "goblin.sqlite");
	const store = openStore(dbPath);
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
			outcome: "kernel upgraded",
			situation: "",
			nextAction: "",
			checkpoints: [],
			completionEvidence: ["booted new kernel", "driver smoke test"],
		},
	});
	return { store, resps, id: responsibility.responsibilityId, dbPath };
}

const ev = (item: string) => ({ item, ref: "journalctl -b", checked: `${item}: observed` });

describe("responsibility reports", () => {
	test("done refuses until evidence covers every completionEvidence item, then closes", () => {
		const r = rig();
		const partial = r.resps.report(
			r.id,
			{ state: "done", reason: "looks done", evidence: [ev("booted new kernel")] },
			"goblin",
		);
		expect(partial).toEqual({ refused: "evidence-missing", missing: ["driver smoke test"] });
		expect(r.resps.get(r.id)!.status).toBe("active");
		expect(r.resps.reportsFor(r.id)).toEqual([]);

		const ok = r.resps.report(
			r.id,
			{
				state: "done",
				reason: "verified",
				evidence: [ev("booted new kernel"), ev(" driver smoke test ")],
			},
			"goblin",
		);
		if ("refused" in ok) throw new Error("refused");
		expect(ok.responsibility.status).toBe("completed");
		expect(ok.responsibility.closedAt).not.toBeNull();
		expect(r.resps.latestReport(r.id)).toMatchObject({
			state: "done",
			reporter: "goblin",
			revision: 1,
		});
		expect(r.resps.report(r.id, { state: "progress", reason: "more" }, "goblin")).toEqual({
			refused: "closed",
		});
	});

	test("dropped closes on its own evidence, not completionEvidence; non-closing reports leave status alone", () => {
		const r = rig();
		r.resps.report(r.id, { state: "blocked", reason: "needs key", question: "add key?" }, "goblin");
		expect(r.resps.get(r.id)!.status).toBe("active");
		r.resps.report(
			r.id,
			{
				state: "dropped",
				reason: "superseded by the operator's PR",
				evidence: [{ item: "superseded", ref: "PR 1", checked: "merged, same change" }],
			},
			"goblin",
		);
		expect(r.resps.get(r.id)!.status).toBe("completed");
		expect(r.resps.reportsFor(r.id).map((x) => x.state)).toEqual(["blocked", "dropped"]);
	});

	test("the input schema refuses shapes the stage cannot use", () => {
		expect(reportInputSchema.safeParse({ state: "waiting", reason: "x" }).success).toBe(false);
		expect(reportInputSchema.safeParse({ state: "done", reason: "x" }).success).toBe(false);
		expect(reportInputSchema.safeParse({ state: "dropped", reason: "x" }).success).toBe(false);
		expect(
			reportInputSchema.safeParse({ state: "dropped", reason: "x", question: "really?" }).success,
		).toBe(false);
		expect(
			reportInputSchema.safeParse({ state: "waiting", reason: "x", resumeWhen: "CI ends" }).success,
		).toBe(true);
	});

	test("legacy waiting/blocked statuses migrate to active plus a blocked migration report", () => {
		const r = rig();
		r.store.db.run(
			"UPDATE responsibilities SET status = 'waiting_for_operator' WHERE responsibility_id = ?",
			[r.id],
		);
		const reopened = openResponsibilities(r.store.db);
		const resp = reopened.get(r.id)!;
		expect(resp.status).toBe("active");
		const latest = reopened.latestReport(r.id);
		expect(latest).toMatchObject({
			reporter: "migration",
			state: "blocked",
			reason: "stored status was waiting_for_operator",
		});
		expect(responsibilityStage(resp, reopened.stageReports(r.id), [])).toMatchObject({
			waitsFor: "operator",
			stage: "blocked",
		});
		// Idempotent: a second open migrates nothing more.
		openResponsibilities(r.store.db);
		expect(reopened.reportsFor(r.id)).toHaveLength(1);
	});

	test("purpose and artifacts round-trip; a pre-purpose table migrates with defaults", () => {
		const r = rig();
		const filed = r.resps.report(
			r.id,
			{
				state: "ready",
				reason: "upgrade notes drafted",
				purpose: "draft",
				artifacts: [{ title: "notes", ref: "docs/upgrade.md" }],
			},
			"goblin",
		);
		if ("refused" in filed) throw new Error("refused");
		expect(filed.report).toMatchObject({
			purpose: "draft",
			artifacts: [{ title: "notes", ref: "docs/upgrade.md" }],
		});

		// An existing database from before the columns: its rows read as
		// plain status posts with no artifacts.
		r.store.db.run("ALTER TABLE responsibility_reports DROP COLUMN artifacts_json");
		r.store.db.run("ALTER TABLE responsibility_reports DROP COLUMN purpose");
		const reopened = openResponsibilities(r.store.db);
		expect(reopened.latestReport(r.id)).toMatchObject({ purpose: "status", artifacts: [] });
	});

	test("T10: first open backfills old data once and leaves only the old latest obligation open", () => {
		const r = rig();
		const second = r.resps.create({
			projectId: r.resps.get(r.id)!.projectId,
			coordinationConversationId: r.resps.get(r.id)!.coordinationConversationId,
			handoverKey: "migration-worker",
			understanding: r.resps.get(r.id)!.understanding,
		}).responsibility;
		const completed = r.resps.create({
			projectId: r.resps.get(r.id)!.projectId,
			coordinationConversationId: r.resps.get(r.id)!.coordinationConversationId,
			handoverKey: "migration-completed",
			understanding: r.resps.get(r.id)!.understanding,
		}).responsibility;
		const legacyBlocked = r.resps.create({
			projectId: r.resps.get(r.id)!.projectId,
			coordinationConversationId: r.resps.get(r.id)!.coordinationConversationId,
			handoverKey: "migration-legacy-blocked",
			understanding: r.resps.get(r.id)!.understanding,
		}).responsibility;
		const oldQuestion = r.resps.report(r.id, {
			state: "blocked", reason: "needs answer", question: "Which one?",
		}, "goblin");
		if ("refused" in oldQuestion) throw new Error("question refused");
		r.resps.report(r.id, { state: "progress", reason: "newer progress" }, "goblin");
		r.resps.report(second.responsibilityId, { state: "ready", reason: "worker claim" }, "worker");
		r.resps.report(completed.responsibilityId, {
			state: "blocked", reason: "closed question", question: "Still needed?",
		}, "goblin");
		r.resps.setStatus(completed.responsibilityId, "completed");
		const legacyQuestion = r.resps.report(legacyBlocked.responsibilityId, {
			state: "blocked",
			reason: "legacy blocked report",
			question: "Keep this question?",
		}, "goblin");
		if ("refused" in legacyQuestion) throw new Error("legacy question refused");
		r.store.db.run(
			"UPDATE responsibilities SET status = 'blocked' WHERE responsibility_id = ?",
			[legacyBlocked.responsibilityId],
		);

		// Simulate the old database: seed the reports/responsibilities first,
		// then remove the new table before the first open under this schema.
		r.store.db.run("DROP TABLE responsibility_resolutions");
		const reopened = openResponsibilities(r.store.db);
		expect(reopened.stageReports(r.id).open).toEqual([]);
		expect(reopened.stageReports(second.responsibilityId).open.map((row) => row.reason))
			.toEqual(["worker claim"]);
		expect(reopened.stageReports(completed.responsibilityId).open).toEqual([]);
		expect(reopened.stageReports(legacyBlocked.responsibilityId).open.map((row) => row.reportId))
			.toEqual([legacyQuestion.report.reportId]);
		const resolution = r.store.db.query<{ kind: string; created_at: string }, [number]>(
			"SELECT kind, created_at FROM responsibility_resolutions WHERE report_id=?",
		).get(oldQuestion.report.reportId);
		expect(resolution).toMatchObject({ kind: "migrated" });
		expect(Date.parse(resolution!.created_at)).toBeGreaterThanOrEqual(
			Date.parse(oldQuestion.report.createdAt),
		);
		expect(responsibilityStage(reopened.get(r.id)!, reopened.stageReports(r.id), []))
			.toMatchObject({ stage: "working", reason: "newer progress" });
		expect(
			responsibilityStage(
				reopened.get(second.responsibilityId)!,
				reopened.stageReports(second.responsibilityId),
				[],
			),
		)
			.toMatchObject({ stage: "assess", reason: "worker claim" });
		expect(
			responsibilityStage(
				reopened.get(completed.responsibilityId)!,
				reopened.stageReports(completed.responsibilityId),
				[],
			),
		)
			.toMatchObject({ stage: "closed" });
		expect(
			responsibilityStage(
				reopened.get(legacyBlocked.responsibilityId)!,
				reopened.stageReports(legacyBlocked.responsibilityId),
				[],
			),
		)
			.toMatchObject({ stage: "question", reason: "Keep this question?" });
		const countBefore = r.store.db.query<{ count: number }, []>(
			"SELECT COUNT(*) AS count FROM responsibility_resolutions",
		).get()!.count;
		openResponsibilities(r.store.db);
		const countAfter = r.store.db.query<{ count: number }, []>(
			"SELECT COUNT(*) AS count FROM responsibility_resolutions",
		).get()!.count;
		expect(countAfter).toBe(countBefore);
		expect(reopened.stageReports(second.responsibilityId).open).toHaveLength(1);
		r.store.close();
	});
});
