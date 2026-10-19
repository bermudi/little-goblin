// Responsibility observer — the deterministic reconciliation: cursor
// + event + wake in one commit, deduped by generation-namespaced
// source keys, outage ≠ disappearance, replacement ≠ the same agent.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore, type ConversationStore } from "./conversation.ts";
import type { OperatorAgent } from "./herdr.ts";
import { setLogFile } from "./log.ts";
import { openProjects } from "./projects.ts";
import { openResponsibilities, type ResponsibilityStore } from "./responsibilities.ts";
import { makeResponsibilityObserver } from "./responsibility-observer.ts";
import { tmpDir, useHome } from "./testkit.ts";
import { openWakeStore } from "./wake-store.ts";

setLogFile(null);

interface Rig {
	store: ConversationStore;
	resps: ResponsibilityStore;
	respId: string;
	attId: number;
	events: { kind: string; text: string }[];
	pumps: number;
	listCalls: number;
	// Mutable per-test agent set — the fake list edge returns this.
	agents: OperatorAgent[];
	failing: boolean;
	observe(): Promise<void>;
	eventsFor(): { sourceKey: string; kind: string; text: string; responsibilityId: string | null }[];
}

const agent = (over: Partial<OperatorAgent> = {}): OperatorAgent => ({
	pane_id: "pane-7",
	workspace_id: "w1",
	tab_id: "t1",
	agent: "pi",
	agent_status: "working",
	name: "worker-1",
	cwd: "/w",
	terminal_title: null,
	workspace_label: null,
	tab_label: null,
	terminal_id: "term-9",
	agent_session: "sess-abc",
	state_change_seq: 1,
	completion_seq: null,
	revision: 1,
	...over,
});

function rig(): Rig {
	const home = useHome(`goblin-obs-${tmpDir().slice(-6)}-`);
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const projects = openProjects(store);
	const project = projects.create({ name: "rig" });
	const conv = store.resolve({ kind: "app", appId: project.slug, chatId: 0, threadId: 0 }, project.dir);
	store.bindProject(conv.id, project.id);
	const resps = openResponsibilities(store.db);
	const wakes = openWakeStore(store.db);
	const { responsibility } = resps.create({
		projectId: project.id,
		coordinationConversationId: conv.id,
		handoverKey: "h1",
		understanding: {
			outcome: "o",
			situation: "s",
			nextAction: "n",
			checkpoints: [],
			completionEvidence: [],
		},
	});
	const att = resps.attach({
		responsibilityId: responsibility.responsibilityId,
		target: {
			server: "local",
			session: "op",
			agentName: "worker-1",
			paneId: "pane-7",
			terminalId: "term-9",
			agentSession: "sess-abc",
			kind: "pi",
			cwd: "/w",
		},
		baseline: {},
		cursor: {
			seq: 1,
			completionSeq: null,
			status: "working",
			agentSession: "sess-abc",
			terminalId: "term-9",
			name: "worker-1",
			missing: false,
		},
	});
	const r: Rig = {
		store,
		resps,
		respId: responsibility.responsibilityId,
		attId: att.attachmentId,
		events: [],
		pumps: 0,
		listCalls: 0,
		agents: [agent()],
		failing: false,
		async observe() {
			const observer = makeResponsibilityObserver({
				db: store.db,
				resps,
				wakes,
				pump: () => {
					r.pumps += 1;
				},
				list: async () => {
					r.listCalls += 1;
					if (r.failing) throw new Error("herdr unreachable");
					return r.agents;
				},
			});
			await observer.observe();
		},
		eventsFor() {
			return store.db
				.query(
					"SELECT source_key AS sourceKey, kind, text, responsibility_id AS responsibilityId FROM work_events ORDER BY event_id",
				)
				.all() as { sourceKey: string; kind: string; text: string; responsibilityId: string | null }[];
		},
	};
	return r;
}

describe("responsibility observer", () => {
	test("a completion tick records one done-candidate and advances the cursor", async () => {
		const r = rig();
		r.agents = [agent({ agent_status: "idle", completion_seq: 4, state_change_seq: 9 })];
		await r.observe();
		const ev = r.eventsFor();
		expect(ev).toHaveLength(1);
		expect(ev[0]!.kind).toBe("done-candidate");
		expect(ev[0]!.responsibilityId).toBe(r.respId);
		expect(r.pumps).toBe(1);
		const cursor = r.resps.getAttachment(r.attId)!.cursor as { completionSeq: number };
		expect(cursor.completionSeq).toBe(4);
		// A repeated poll over the same snapshot dedupes to nothing.
		await r.observe();
		expect(r.eventsFor()).toHaveLength(1);
		r.store.close();
	});

	test("stable work commits cursor only — no events, no model spend", async () => {
		const r = rig();
		r.agents = [agent({ state_change_seq: 7 })];
		await r.observe();
		expect(r.eventsFor()).toHaveLength(0);
		const cursor = r.resps.getAttachment(r.attId)!.cursor as { seq: number };
		expect(cursor.seq).toBe(7);
		r.store.close();
	});

	test("a same-pane replacement marks identity_changed and stops watching it", async () => {
		const r = rig();
		r.agents = [agent({ agent_session: "sess-new", state_change_seq: 5 })];
		await r.observe();
		const att = r.resps.getAttachment(r.attId)!;
		expect(att.health).toBe("identity_changed");
		expect(r.eventsFor().map((e) => e.kind)).toEqual(["identity-changed"]);
		// The replacement stays hands-off — no further reconciliation.
		r.agents = [agent({ agent_session: "sess-new", state_change_seq: 6, completion_seq: 8 })];
		await r.observe();
		expect(r.eventsFor()).toHaveLength(1);
		r.store.close();
	});

	test("disappearance marks missing once; reappearance recovers", async () => {
		const r = rig();
		r.agents = [];
		await r.observe();
		expect(r.resps.getAttachment(r.attId)!.health).toBe("missing");
		expect(r.eventsFor().map((e) => e.kind)).toEqual(["agent-missing"]);
		await r.observe(); // still missing — no second event
		expect(r.eventsFor()).toHaveLength(1);
		r.agents = [agent({ state_change_seq: 4 })];
		await r.observe();
		expect(r.resps.getAttachment(r.attId)!.health).toBe("attached");
		expect(r.eventsFor().map((e) => e.kind)).toEqual(["agent-missing", "agent-recovered"]);
		r.store.close();
	});

	test("an unreachable target leaves every attachment untouched", async () => {
		const r = rig();
		r.failing = true;
		await r.observe();
		expect(r.resps.getAttachment(r.attId)!.health).toBe("attached");
		expect(r.eventsFor()).toHaveLength(0);
		r.store.close();
	});

	test("a cursor regression reconciles instead of replaying completions", async () => {
		const r = rig();
		// First poll lands a completion so the cursor is ahead.
		r.agents = [agent({ completion_seq: 5, state_change_seq: 10 })];
		await r.observe();
		expect(r.eventsFor().map((e) => e.kind)).toEqual(["done-candidate"]);
		// The server resets its sequence — the old completion must not
		// read as fresh work.
		r.agents = [agent({ completion_seq: 1, state_change_seq: 2 })];
		await r.observe();
		expect(r.eventsFor().map((e) => e.kind)).toEqual(["done-candidate", "cursor-reset"]);
		r.store.close();
	});

	test("a blocked transition is a development; staying blocked is not", async () => {
		const r = rig();
		r.agents = [agent({ agent_status: "blocked", state_change_seq: 3 })];
		await r.observe();
		expect(r.eventsFor().map((e) => e.kind)).toEqual(["blocked-candidate"]);
		r.agents = [agent({ agent_status: "blocked", state_change_seq: 4 })];
		await r.observe();
		expect(r.eventsFor()).toHaveLength(1);
		r.store.close();
	});
});
