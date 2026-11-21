import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./conversation.ts";
import { log, setLogFile } from "./log.ts";
import type { GithubIssue, PrReadiness } from "./pr-readiness.ts";
import { openProjects } from "./projects.ts";
import { openResponsibilities } from "./responsibilities.ts";
import { makeIssueStore, makeReadinessObserver, readinessReport } from "./responsibility-readiness.ts";
import { prReadinessFixture } from "./test-helpers/pr-readiness.ts";
import { deferred, tmpDir, useHome } from "./testkit.ts";
import { openWakeStore } from "./wake-store.ts";

setLogFile(null);

const ISSUE: GithubIssue = { repository: "owner/repo", number: 7 };

function rig(opts: { link?: boolean } = {}) {
	const home = useHome(`goblin-ready-${tmpDir().slice(-6)}-`);
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const project = openProjects(store).create({ name: "rig" });
	const conv = store.resolve({ kind: "app", appId: project.slug, chatId: 0, threadId: 0 }, project.dir);
	store.bindProject(conv.id, project.id);
	const resps = openResponsibilities(store.db);
	const wakes = openWakeStore(store.db);
	const issues = makeIssueStore(store.db);
	const { responsibility } = resps.create({
		projectId: project.id,
		coordinationConversationId: conv.id,
		handoverKey: "h1",
		understanding: { outcome: "o", situation: "s", nextAction: "n", checkpoints: [], completionEvidence: [] },
	});
	const id = responsibility.responsibilityId;
	if (opts.link !== false) issues.link(id, ISSUE);
	let clock = Date.now();
	const r = {
		store,
		resps,
		wakes,
		issues,
		id,
		conv: conv.id,
		reads: 0,
		pumps: 0,
		next: (): PrReadiness => prReadinessFixture(),
		advance(ms: number) {
			clock += ms;
		},
		read: async (_issue: GithubIssue): Promise<PrReadiness> => ({ ...r.next(), observedAt: new Date(clock).toISOString() }),
		observer: null as ReturnType<typeof makeReadinessObserver> | null,
		async observe() {
			r.observer ??= makeReadinessObserver({
				db: store.db,
				resps,
				wakes,
				issues,
				now: () => new Date(clock),
				pump: () => {
					r.pumps += 1;
				},
				read: (issue) => {
					r.reads += 1;
					return r.read(issue);
				},
			});
			await r.observer.observe();
		},
		events() {
			return store.db
				.query("SELECT source_key AS sourceKey, kind, text FROM work_events ORDER BY event_id")
				.all() as { sourceKey: string; kind: string; text: string }[];
		},
	};
	return r;
}

const noPr = (issueClosed: boolean): PrReadiness => ({
	...prReadinessFixture(),
	result: { kind: "no-pr", issueClosed },
});

describe("pr readiness observer", () => {
	test("an open issue with no PR yet is a silent baseline, and fresh observations are not re-read", async () => {
		const r = rig();
		r.next = () => noPr(false);
		await r.observe();
		expect(r.reads).toBe(1);
		expect(r.events()).toEqual([]);
		expect(r.resps.reportsFor(r.id)).toEqual([]);
		expect(r.pumps).toBe(0);
		r.advance(30_000);
		await r.observe();
		expect(r.reads).toBe(1);
	});

	test("each change in GitHub facts files one sourced report and one wake; unchanged facts wake nothing", async () => {
		const r = rig();
		r.next = () => noPr(false);
		await r.observe();
		r.advance(61_000);
		r.next = () => prReadinessFixture("pending");
		await r.observe();
		r.advance(61_000);
		await r.observe();
		expect(r.reads).toBe(3);
		expect(r.events()).toHaveLength(1);
		const [waiting] = r.resps.reportsFor(r.id);
		expect(waiting).toMatchObject({ state: "waiting", reporter: "worker" });
		expect(waiting?.reason).toStartWith("Not ready: CI is pending");
		expect(waiting?.evidence.map((e) => e.item)).toEqual([
			"Closing PR",
			"PR head",
			"Verifier verdict",
			"CI on PR head",
		]);
		r.advance(61_000);
		r.next = () => prReadinessFixture("green");
		await r.observe();
		r.advance(61_000);
		r.next = () => prReadinessFixture("red");
		await r.observe();
		expect(r.resps.reportsFor(r.id).map((x) => x.state)).toEqual(["waiting", "ready", "blocked"]);
		const events = r.events();
		expect(events.map((e) => e.kind)).toEqual(["pr-readiness", "pr-readiness", "pr-readiness"]);
		expect(events[1]?.text).toContain("PR readiness facts pass");
		expect(events[1]?.text).toContain("do not poll it with model turns");
		expect(r.wakes.pending(r.conv)).not.toHaveLength(0);
		expect(r.pumps).toBe(3);
		expect(r.resps.get(r.id)?.status).toBe("active");
	});

	test("a closed issue with no PR stops the GitHub reads", async () => {
		const r = rig();
		r.next = () => noPr(true);
		await r.observe();
		r.advance(10 * 61_000);
		await r.observe();
		expect(r.reads).toBe(1);
		expect(r.events()).toHaveLength(1);
	});

	test("an unavailable GitHub read records nothing and retries on the next tick", async () => {
		const r = rig();
		const warn = spyOn(log, "warn").mockImplementation(() => {});
		try {
			r.next = () => ({ ...prReadinessFixture(), result: { kind: "unavailable", reason: "HTTP 502" } });
			await r.observe();
			await r.observe();
			expect(r.reads).toBe(2);
			expect(r.events()).toEqual([]);
			expect(r.issues.get(r.id)?.readiness).toBeNull();
		} finally {
			warn.mockRestore();
		}
	});

	test("a pause that lands during the GitHub read wins over the observation", async () => {
		const r = rig();
		const held = deferred<PrReadiness>();
		const entered = deferred();
		r.read = () => {
			entered.resolve();
			return held.promise;
		};
		const pass = r.observe();
		await entered.promise;
		r.resps.setStatus(r.id, "paused");
		held.resolve(prReadinessFixture("green"));
		await pass;
		expect(r.events()).toEqual([]);
		expect(r.resps.reportsFor(r.id)).toEqual([]);
		expect(r.issues.get(r.id)?.readiness).toBeNull();
	});

	test("responsibilities without a linked issue never query GitHub", async () => {
		const r = rig({ link: false });
		await r.observe();
		expect(r.reads).toBe(0);
	});

	test("linking twice keeps the first issue", () => {
		const r = rig();
		r.issues.link(r.id, { repository: "other/repo", number: 9 });
		expect(r.issues.get(r.id)?.issue).toEqual(ISSUE);
	});
});

describe("readinessReport", () => {
	test("a verdict for an older head blocks even with green CI", () => {
		const observation = prReadinessFixture("green");
		observation.result.verifier!.sha = "b".repeat(40);
		observation.result.ready = false;
		observation.result.reasons = ["Verifier verdict is for an older or different SHA"];
		expect(readinessReport(observation, new Date())).toMatchObject({
			state: "blocked",
			reason: expect.stringContaining("older or different SHA"),
		});
	});

	test("pending CI resumes after the next observation window, never in the past", () => {
		const observation = { ...prReadinessFixture("pending"), observedAt: "2000-01-01T00:00:00.000Z" };
		const now = new Date("2026-11-20T00:00:00.000Z");
		expect(readinessReport(observation, now).resumeWhen).toBe("2026-11-20T00:02:00.000Z");
	});
});
