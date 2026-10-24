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
import { feedForProject, feedOpen, FEED_EVENT_WINDOW } from "./responsibility-feed.ts";
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
