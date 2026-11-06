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
		expect(responsibilityStage(resp, latest, [])).toMatchObject({
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
});
