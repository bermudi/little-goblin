// Responsibility observer — the deterministic reconciliation: cursor
// + event + wake in one commit, deduped by generation-namespaced
// source keys, outage ≠ disappearance, replacement ≠ the same agent.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore, type ConversationStore } from "./conversation.ts";
import { HerdrError, type OperatorAgent } from "./herdr.ts";
import { setLogFile } from "./log.ts";
import { openProjects } from "./projects.ts";
import { openResponsibilities, type ResponsibilityStore } from "./responsibilities.ts";
import { makeResponsibilityObserver } from "./responsibility-observer.ts";
import { deferred, tmpDir, useHome } from "./testkit.ts";
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

function rig(list?: () => Promise<OperatorAgent[]>): Rig {
	const home = useHome(`goblin-obs-${tmpDir().slice(-6)}-`);
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const projects = openProjects(store);
	const project = projects.create({ name: "rig" });
	const conv = store.resolve(
		{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
		project.dir,
	);
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
					if (list) return list();
					if (r.failing) throw new HerdrError("agent list", "unreachable", "herdr unreachable");
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
				.all() as {
				sourceKey: string;
				kind: string;
				text: string;
				responsibilityId: string | null;
			}[];
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

	for (const change of [
		"detach",
		"reattach",
		"identity_changed",
		"paused",
		"cancelled",
		"completed",
	] as const) {
		test(`in-flight observation cannot overwrite ${change}`, async () => {
			const gate = deferred<OperatorAgent[]>();
			const r = rig(() => gate.promise);
			const observing = r.observe();
			expect(r.listCalls).toBe(1); // Awaiting the external list, not a timer.
			if (change === "detach") r.resps.detach(r.attId);
			else if (change === "reattach") {
				const att = r.resps.getAttachment(r.attId)!;
				r.resps.reattach(r.attId, { ...att.target, agentSession: "deliberate-new" }, {});
			} else if (change === "identity_changed") r.resps.setHealth(r.attId, change);
			else r.resps.setStatus(r.respId, change);
			const expected = r.resps.getAttachment(r.attId);
			gate.resolve([]); // Would otherwise mark missing and queue a wake.
			await observing;
			expect(r.resps.getAttachment(r.attId)).toEqual(expected);
			expect(r.eventsFor()).toHaveLength(0);
			expect(r.store.db.query("SELECT * FROM wake_deliveries").all()).toHaveLength(0);
			r.store.close();
		});
	}

	for (const baseline of ["reattach", "null-observation"] as const) {
		test(`replacement is compared with the durable binding after ${baseline}`, async () => {
			const r = rig();
			if (baseline === "reattach") {
				const att = r.resps.getAttachment(r.attId)!;
				r.resps.reattach(r.attId, att.target, {});
				expect(r.resps.getAttachment(r.attId)!.cursor).toBeNull();
			} else {
				r.agents = [agent({ agent_session: null, state_change_seq: 2 })];
				await r.observe();
			}
			r.agents = [agent({ agent_session: "replacement", completion_seq: 1, state_change_seq: 3 })];
			await r.observe();
			expect(r.resps.getAttachment(r.attId)!.health).toBe("identity_changed");
			expect(r.eventsFor().map((e) => e.kind)).toEqual(["identity-changed"]);
			expect(r.resps.getAttachment(r.attId)!.target.agentSession).toBe("sess-abc");
			r.store.close();
		});
	}

	test("a null cursor baselines the first poll — a pre-existing completion is not a candidate", async () => {
		const r = rig();
		const att = r.resps.getAttachment(r.attId)!;
		r.resps.reattach(r.attId, att.target, {});
		expect(r.resps.getAttachment(r.attId)!.cursor).toBeNull();
		r.agents = [agent({ completion_seq: 3, state_change_seq: 9 })];
		await r.observe();
		expect(r.eventsFor()).toHaveLength(0);
		const cursor = r.resps.getAttachment(r.attId)!.cursor as {
			seq: number;
			completionSeq: number;
		};
		expect(cursor).toMatchObject({ seq: 9, completionSeq: 3 });
		// A tick past the baseline reports normally.
		r.agents = [agent({ completion_seq: 4, state_change_seq: 10 })];
		await r.observe();
		expect(r.eventsFor().map((e) => e.kind)).toEqual(["done-candidate"]);
		r.store.close();
	});

	test("paused responsibilities neither poll nor develop; resume can observe completion", async () => {
		const r = rig();
		const att = r.resps.getAttachment(r.attId);
		r.resps.setStatus(r.respId, "paused");
		for (const agents of [
			[],
			[agent({ agent_status: "blocked" })],
			[agent({ completion_seq: 1, state_change_seq: 3 })],
		]) {
			r.agents = agents;
			await r.observe();
		}
		expect(r.listCalls).toBe(0);
		expect(r.resps.getAttachment(r.attId)).toEqual(att);
		expect(r.eventsFor()).toHaveLength(0);
		expect(r.store.db.query("SELECT * FROM wake_deliveries").all()).toHaveLength(0);
		r.resps.setStatus(r.respId, "active");
		await r.observe();
		expect(r.eventsFor().map((e) => e.kind)).toEqual(["done-candidate"]);
		r.store.close();
	});

	test("reset epochs durably distinguish reused completion and reset numbers", async () => {
		const r = rig();
		r.agents = [agent({ state_change_seq: 10, completion_seq: 1 })];
		await r.observe();
		for (let epoch = 1; epoch <= 2; epoch++) {
			r.agents = [agent({ state_change_seq: 0, completion_seq: 0 })];
			await r.observe();
			expect(r.resps.getAttachment(r.attId)!.cursor).toMatchObject({ epoch });
			// rig recreates the observer each poll: identity must live on disk.
			r.agents = [agent({ state_change_seq: 1, completion_seq: 1 })];
			await r.observe();
			await r.observe(); // stable duplicate within this epoch
		}
		const events = r.eventsFor();
		expect(events.filter((e) => e.kind === "done-candidate")).toHaveLength(3);
		expect(events.filter((e) => e.kind === "cursor-reset")).toHaveLength(2);
		expect(new Set(events.map((e) => e.sourceKey)).size).toBe(5);
		r.store.close();
	});

	test("mutation failure rejects observation and rolls back cursor, health, event and wake", async () => {
		const r = rig();
		const before = r.resps.getAttachment(r.attId);
		r.store.db.exec(`CREATE TRIGGER reject_observer_wake BEFORE INSERT ON wake_events
			BEGIN SELECT RAISE(ABORT, 'observer wake storage failed'); END`);
		r.agents = [];
		await expect(r.observe()).rejects.toThrow("observer wake storage failed");
		expect(r.resps.getAttachment(r.attId)).toEqual(before);
		expect(r.eventsFor()).toHaveLength(0);
		expect(r.store.db.query("SELECT * FROM wake_deliveries").all()).toHaveLength(0);
		expect(r.pumps).toBe(0);
		r.store.close();
	});

	test("JSON corrupted during list is re-read at commit and rejects instead of being overwritten", async () => {
		const gate = deferred<OperatorAgent[]>();
		const r = rig(() => gate.promise);
		const observing = r.observe();
		r.store.db
			.query("UPDATE attachments SET cursor_json = ? WHERE attachment_id = ?")
			.run("{broken", r.attId);
		gate.resolve([agent({ completion_seq: 1 })]);
		await expect(observing).rejects.toBeInstanceOf(SyntaxError);
		expect(r.eventsFor()).toHaveLength(0);
		expect(r.pumps).toBe(0);
		r.store.close();
	});

	test("invalid cursor JSON shape fails validation, never defaults to a fresh baseline", async () => {
		const r = rig();
		r.resps.updateCursor(r.attId, {});
		await expect(r.observe()).rejects.toThrow();
		expect(r.eventsFor()).toHaveLength(0);
		expect(r.pumps).toBe(0);
		r.store.close();
	});

	test("malformed adapter output propagates rather than looking unreachable", async () => {
		const error = new Error("herdr agent list: stdout is not JSON");
		const r = rig(async () => {
			throw error;
		});
		const before = r.resps.getAttachment(r.attId);
		await expect(r.observe()).rejects.toBe(error);
		expect(r.resps.getAttachment(r.attId)).toEqual(before);
		expect(r.pumps).toBe(0);
		r.store.close();
	});
});
