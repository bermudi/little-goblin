// The feed read model's window: the wire carries each responsibility's
// newest developments — bounded, ascending, wake-joined — plus a count
// of the older durable rows it omitted. The rows themselves are never
// pruned (anchored conversations refuse deletion), so the window is the
// only bound the polling client has.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore, type ConversationStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { openProjects, type ProjectStore } from "./projects.ts";
import {
	openResponsibilities,
	type ResponsibilityStore,
	type Understanding,
} from "./responsibilities.ts";
import {
	FEED_EVENT_WINDOW,
	FEED_POST_WINDOW,
	feedForProject,
	feedOpen,
} from "./responsibility-feed.ts";
import { openWakeStore, type WakeStore } from "./wake-store.ts";
import { tmpDir, useHome } from "./testkit.ts";

setLogFile(null);

interface Rig {
	store: ConversationStore;
	projects: ProjectStore;
	resps: ResponsibilityStore;
	wakes: WakeStore;
	projectId: string;
	convId: string;
}

function rig(): Rig {
	const home = useHome(`goblin-feed-${tmpDir().slice(-6)}-`);
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const projects = openProjects(store);
	const project = projects.create({ name: "feed" });
	const conv = store.resolve(
		{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
		project.dir,
	);
	store.bindProject(conv.id, project.id);
	return {
		store,
		projects,
		resps: openResponsibilities(store.db),
		wakes: openWakeStore(store.db),
		projectId: project.id,
		convId: conv.id,
	};
}

const understanding = (): Understanding => ({
	outcome: "land the fix",
	situation: "agent is mid-task",
	nextAction: "check the diff",
	checkpoints: [],
	completionEvidence: ["ci green"],
});

function seedEvents(r: Rig, responsibilityId: string, count: number): number[] {
	const ids: number[] = [];
	for (let i = 0; i < count; i++) {
		const rec = r.wakes.record({
			sourceKey: `seed:${responsibilityId}:${i}`,
			conversationId: r.convId,
			kind: "scheduled-checkin",
			text: `development ${i}`,
			facts: { i },
			origin: "program",
			responsibilityId,
		});
		ids.push(rec.eventId);
	}
	return ids;
}

describe("responsibility feed window", () => {
	test("beyond the window: newest N ascending, older rows counted not serialized", () => {
		const r = rig();
		const resp = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "feed:w",
			understanding: understanding(),
		}).responsibility;
		const ids = seedEvents(r, resp.responsibilityId, FEED_EVENT_WINDOW + 12);
		const item = feedForProject({ db: r.store.db, resps: r.resps }, r.projectId)[0]!;
		expect(item.events).toHaveLength(FEED_EVENT_WINDOW);
		expect(item.eventsTruncated).toBe(12);
		expect(item.events.map((e) => e.eventId)).toEqual(ids.slice(12));
		// Ascending, wake-joined, and freshness still the newest row's.
		const eventIds = item.events.map((e) => e.eventId);
		expect([...eventIds].sort((a, b) => a - b)).toEqual(eventIds);
		expect(item.events.every((e) => e.wake !== null)).toBe(true);
		expect(item.lastActivityAt).toBe(item.events[item.events.length - 1]!.createdAt);
		// Durable rows untouched — the count sees all of them.
		const rows = r.store.db
			.query("SELECT COUNT(*) AS n FROM work_events WHERE responsibility_id = ?")
			.get(resp.responsibilityId) as { n: number };
		expect(rows.n).toBe(FEED_EVENT_WINDOW + 12);
		r.store.close();
	});

	test("within the window: everything, ascending, nothing truncated", () => {
		const r = rig();
		const resp = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "feed:small",
			understanding: understanding(),
		}).responsibility;
		const ids = seedEvents(r, resp.responsibilityId, 3);
		const home = feedOpen({ db: r.store.db, resps: r.resps })[0]!;
		expect(home.responsibility.responsibilityId).toBe(resp.responsibilityId);
		expect(home.events.map((e) => e.eventId)).toEqual(ids);
		expect(home.eventsTruncated).toBe(0);
		r.store.close();
	});
});

describe("outcome posts", () => {
	test("reports become posts, newest first, labelled by whose word they are", () => {
		const r = rig();
		const { responsibility } = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "posts",
			understanding: understanding(),
		});
		const id = responsibility.responsibilityId;
		r.resps.report(id, { state: "progress", reason: "reproduced" }, "goblin");
		r.resps.report(id, { state: "ready", reason: "run #1 finished" }, "worker", {
			sourceKey: "subagent:1:0:done",
		});
		// Routine activity stays out of posts.
		seedEvents(r, id, 2);
		let [item] = feedForProject({ db: r.store.db, resps: r.resps }, r.projectId);
		expect(item!.posts.map((p) => [p.report.reason, p.review, p.current])).toEqual([
			["run #1 finished", "unreviewed", true],
			["reproduced", "assessed", true],
		]);
		expect(item!.events).toHaveLength(2);

		// Goblin's later report reviews the claim; a correction leaves both
		// on the record but no longer current.
		r.resps.report(id, { state: "blocked", reason: "diff touches the ABI" }, "goblin");
		r.resps.revise(id, { ...understanding(), nextAction: "keep the ABI" });
		[item] = feedForProject({ db: r.store.db, resps: r.resps }, r.projectId);
		expect(item!.posts.map((p) => [p.review, p.current])).toEqual([
			["assessed", false],
			["reviewed", false],
			["assessed", false],
		]);
	});

	test("a report counts as activity, so a post never sits under 'no activity'", () => {
		const r = rig();
		const { responsibility } = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "fresh",
			understanding: understanding(),
		});
		const id = responsibility.responsibilityId;
		let [item] = feedForProject({ db: r.store.db, resps: r.resps }, r.projectId);
		expect(item!.lastActivityAt).toBeNull();
		const filed = r.resps.report(id, { state: "progress", reason: "moving" }, "goblin");
		if ("refused" in filed) throw new Error("refused");
		[item] = feedForProject({ db: r.store.db, resps: r.resps }, r.projectId);
		expect(item!.lastActivityAt).toBe(filed.report.createdAt);
		// A newer development still wins.
		const [ev] = seedEvents(r, id, 1);
		expect(ev).toBeDefined();
		[item] = feedForProject({ db: r.store.db, resps: r.resps }, r.projectId);
		expect(item!.lastActivityAt! >= filed.report.createdAt).toBe(true);
	});

	test("beyond the window: newest posts only, older counted", () => {
		const r = rig();
		const { responsibility } = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "posts-window",
			understanding: understanding(),
		});
		const id = responsibility.responsibilityId;
		for (let i = 0; i < FEED_POST_WINDOW + 3; i++)
			r.resps.report(id, { state: "progress", reason: `step ${i}` }, "goblin");
		const [item] = feedOpen({ db: r.store.db, resps: r.resps });
		expect(item!.posts).toHaveLength(FEED_POST_WINDOW);
		expect(item!.posts[0]!.report.reason).toBe(`step ${FEED_POST_WINDOW + 2}`);
		expect(item!.postsTruncated).toBe(3);
	});
});
