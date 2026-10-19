// Responsibility service — the handover verbs: one-transaction
// acceptance (responsibility + attachments + durable handover event),
// idempotent on the handover key, and dispatch through the named
// gates — nothing sends stale, nothing sends twice, nothing sends
// without a bindable identity.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore, type ConversationStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { openProjects } from "./projects.ts";
import {
	openResponsibilities,
	type AttachmentTarget,
	type ResponsibilityStore,
	type Understanding,
} from "./responsibilities.ts";
import { makeManagedSendEdge, makeResponsibilityService } from "./responsibility-service.ts";
import {
	HerdrRefusal,
	makeOperatorHerdr,
	type HerdrRunResult,
	type HerdrRunner,
	type OperatorAgent,
} from "./herdr.ts";
import { openPrograms, type ProgramsStore } from "./programs.ts";
import { Database } from "bun:sqlite";
import { tmpDir, useHome, waitUntil } from "./testkit.ts";
import { feedForProject } from "./responsibility-feed.ts";
import { openWakeStore } from "./wake-store.ts";
import { responsibilityTool } from "./agent/tools/responsibility.ts";

setLogFile(null);

interface Rig {
	store: ConversationStore;
	resps: ResponsibilityStore;
	programs: ProgramsStore;
	svc: ReturnType<typeof makeResponsibilityService>;
	projectId: string;
	convId: string;
	pumps: number;
	dbPath: string;
}

function rig(): Rig {
	const home = useHome(`goblin-rsvc-${tmpDir().slice(-6)}-`);
	mkdirSync(join(home, "state"), { recursive: true });
	const dbPath = join(home, "state", "goblin.sqlite");
	const store = openStore(dbPath);
	const projects = openProjects(store);
	const project = projects.create({ name: "rig" });
	const conv = store.resolve(
		{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
		project.dir,
	);
	store.bindProject(conv.id, project.id);
	const resps = openResponsibilities(store.db);
	const wakes = openWakeStore(store.db);
	const programs = openPrograms(join(home, "state", "programs.sqlite"));
	const r: Rig = {
		store,
		resps,
		programs,
		projectId: project.id,
		convId: conv.id,
		pumps: 0,
		dbPath,
		svc: makeResponsibilityService({
			db: store.db,
			resps,
			wakes,
			programs,
			pump: () => {
				r.pumps += 1;
			},
		}),
	};
	return r;
}

const understanding = (): Understanding => ({
	outcome: "land the fix",
	situation: "agent mid-task",
	nextAction: "check the diff",
	checkpoints: [],
	completionEvidence: ["ci green"],
});

const target = (over: Partial<AttachmentTarget> = {}): AttachmentTarget => ({
	server: "local",
	session: "default",
	agentName: "worker-1",
	paneId: "pane-7",
	terminalId: "term-9",
	agentSession: "sess-abc",
	kind: "pi",
	cwd: "/w",
	...over,
});

// The post-wait agent record prompt returns — default is the bound
// session; override agent_session to simulate a mid-dispatch swap.
const reported = (over: Partial<OperatorAgent> = {}): OperatorAgent => ({
	pane_id: "pane-7",
	workspace_id: "ws-1",
	tab_id: "tab-1",
	agent: "pi",
	agent_status: "working",
	name: "worker-1",
	cwd: "/w",
	terminal_title: null,
	workspace_label: null,
	tab_label: null,
	terminal_id: "term-9",
	agent_session: "sess-abc",
	state_change_seq: 4,
	completion_seq: null,
	revision: 7,
	...over,
});

describe("responsibility service", () => {
	test("accept commits responsibility + attachments + handover event atomically", () => {
		const r = rig();
		const { responsibility, created } = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "handover:m1",
			understanding: understanding(),
			attachments: [{ target: target(), baseline: { status: "working" } }],
		});
		expect(created).toBe(true);
		// Programs wired → the follow-up linked at accept → armed.
		expect(responsibility.armed).toBe(true);
		expect(responsibility.notArmedReason).toBeNull();
		expect(responsibility.followupProgramId).not.toBeNull();
		const followup = r.programs.get(Number(responsibility.followupProgramId));
		expect(followup).not.toBeNull();
		expect(followup!.responsibilityId).toBe(responsibility.responsibilityId);
		expect(followup!.chatId).toBe(0);
		expect(followup!.cron).not.toBeNull();
		const atts = r.resps.attachmentsFor(responsibility.responsibilityId);
		expect(atts).toHaveLength(1);
		expect(atts[0]!.target.agentSession).toBe("sess-abc");
		const events = r.store.db
			.query("SELECT kind, responsibility_id AS rid FROM work_events")
			.all() as { kind: string; rid: string }[];
		expect(events).toEqual([{ kind: "handover", rid: responsibility.responsibilityId }]);
		expect(r.pumps).toBe(1);
		r.store.close();
	});

	test("a duplicate handover returns the same responsibility — no doubled attachments", () => {
		const r = rig();
		const input = {
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "handover:m1",
			understanding: understanding(),
			attachments: [{ target: target(), baseline: {} }],
		};
		const a = r.svc.accept(input);
		const b = r.svc.accept(input);
		expect(b.created).toBe(false);
		expect(b.responsibility.responsibilityId).toBe(a.responsibility.responsibilityId);
		expect(r.resps.attachmentsFor(a.responsibility.responsibilityId)).toHaveLength(1);
		expect(
			(r.store.db.query("SELECT COUNT(*) AS n FROM work_events").get() as { n: number }).n,
		).toBe(1);
		r.store.close();
	});

	test("ensureFollowup is create-once and relinks a dangling program id", () => {
		const r = rig();
		const { responsibility } = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "handover:m1",
			understanding: understanding(),
			attachments: [{ target: target(), baseline: {} }],
		});
		const id = responsibility.responsibilityId;
		const first = r.svc.ensureFollowup(id);
		const again = r.svc.ensureFollowup(id);
		expect(again!.id).toBe(first!.id);
		expect(r.programs.list().filter((p) => p.responsibilityId === id)).toHaveLength(1);
		// A deleted link recreates under a new id and stays armed.
		r.programs.remove(first!.id);
		const relinked = r.svc.ensureFollowup(id);
		expect(relinked!.id).not.toBe(first!.id);
		expect(r.resps.get(id)!.followupProgramId).toBe(String(relinked!.id));
		expect(r.resps.get(id)!.armed).toBe(true);
		r.store.close();
	});

	test("dispatch sends a validated operation once and marks it acknowledged", async () => {
		const r = rig();
		const { responsibility } = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "h1",
			understanding: understanding(),
			attachments: [{ target: target(), baseline: {} }],
		});
		const att = r.resps.attachmentsFor(responsibility.responsibilityId)[0]!;
		const prepared = r.resps.prepareOperation({
			responsibilityId: responsibility.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "pick up the review",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		const briefs: string[] = [];
		const out = await r.svc.dispatch(prepared.operation.operationId, async (brief) => {
			briefs.push(brief);
			return { ok: true };
		});
		expect(out).toEqual({ sent: true });
		expect(briefs).toEqual(["pick up the review"]);
		expect(r.resps.getOperation(prepared.operation.operationId)!.state).toBe("acknowledged");
		// The same operation under any new tool-call id refuses — sent is terminal.
		const again = await r.svc.dispatch(prepared.operation.operationId, async () => ({}));
		expect(again).toEqual({ refused: "already-terminal" });
		expect(briefs).toHaveLength(1);
		r.store.close();
	});

	test("a send failure marks uncertain — never resent", async () => {
		const r = rig();
		const { responsibility } = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "h1",
			understanding: understanding(),
			attachments: [{ target: target(), baseline: {} }],
		});
		const att = r.resps.attachmentsFor(responsibility.responsibilityId)[0]!;
		const prepared = r.resps.prepareOperation({
			responsibilityId: responsibility.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		let calls = 0;
		const out = await r.svc.dispatch(prepared.operation.operationId, async () => {
			calls += 1;
			throw new Error("timeout after possible send");
		});
		expect(calls).toBe(1);
		expect(r.resps.getOperation(prepared.operation.operationId)!.state).toBe("uncertain");
		// And it can never dispatch again.
		const again = await r.svc.dispatch(prepared.operation.operationId, async () => ({}));
		expect(again).toEqual({ refused: "delivery-uncertain" });
		expect(calls).toBe(1);
		r.store.close();
	});

	test("the wired edge sends when the post-send session matches the bound one", async () => {
		const r = rig();
		const { responsibility } = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "h1",
			understanding: understanding(),
			attachments: [{ target: target(), baseline: {} }],
		});
		const att = r.resps.attachmentsFor(responsibility.responsibilityId)[0]!;
		const prepared = r.resps.prepareOperation({
			responsibilityId: responsibility.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "ship it",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		const calls: { pane: string; expect: string; text: string }[] = [];
		const edge = makeManagedSendEdge({
			prompt: async (pane, expect_, text) => {
				calls.push({ pane, expect: expect_, text });
				return reported({ agent_session: "sess-abc" });
			},
		});
		const out = await r.svc.dispatch(prepared.operation.operationId, edge);
		expect(out).toEqual({ sent: true });
		expect(calls).toEqual([{ pane: "pane-7", expect: "pi", text: "ship it" }]);
		expect(r.resps.getOperation(prepared.operation.operationId)!.state).toBe("acknowledged");
		r.store.close();
	});

	test("a post-send session change lands uncertain — logged, terminal, never resent", async () => {
		const r = rig();
		const { responsibility } = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "h1",
			understanding: understanding(),
			attachments: [{ target: target(), baseline: {} }],
		});
		const att = r.resps.attachmentsFor(responsibility.responsibilityId)[0]!;
		const prepared = r.resps.prepareOperation({
			responsibilityId: responsibility.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		let calls = 0;
		const edge = makeManagedSendEdge({
			prompt: async () => {
				calls += 1;
				return reported({ agent_session: "sess-NEW" });
			},
		});
		const out = await r.svc.dispatch(prepared.operation.operationId, edge);
		expect(calls).toBe(1);
		expect(out).toEqual({ refused: "delivery-uncertain" });
		const op = r.resps.getOperation(prepared.operation.operationId)!;
		expect(op.state).toBe("uncertain");
		// And the same op can never dispatch again.
		const again = await r.svc.dispatch(prepared.operation.operationId, edge);
		expect(again).toEqual({ refused: "delivery-uncertain" });
		expect(calls).toBe(1);
		r.store.close();
	});

	test("an edge refusal is a named refusal — nothing was sent", async () => {
		const r = rig();
		const { responsibility } = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "h1",
			understanding: understanding(),
			attachments: [{ target: target({ kind: null }), baseline: {} }],
		});
		const att = r.resps.attachmentsFor(responsibility.responsibilityId)[0]!;
		const prepared = r.resps.prepareOperation({
			responsibilityId: responsibility.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		let calls = 0;
		const edge = makeManagedSendEdge({
			prompt: async () => {
				calls += 1;
				return reported({});
			},
		});
		// kind null → the edge refuses before prompt is ever invoked.
		const out = await r.svc.dispatch(prepared.operation.operationId, edge);
		expect(calls).toBe(0);
		expect(out).toEqual({ refused: "kind_mismatch" });
		const op = r.resps.getOperation(prepared.operation.operationId)!;
		expect(op.state).toBe("refused");
		expect(op.refusal).toBe("kind_mismatch");
		r.store.close();
	});

	test("a prompt refusal from Herdr refuses the op by name", async () => {
		const r = rig();
		const { responsibility } = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "h1",
			understanding: understanding(),
			attachments: [{ target: target(), baseline: {} }],
		});
		const att = r.resps.attachmentsFor(responsibility.responsibilityId)[0]!;
		const prepared = r.resps.prepareOperation({
			responsibilityId: responsibility.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		const edge = makeManagedSendEdge({
			prompt: async () => {
				throw new HerdrRefusal("agent_not_found", "pane hosts no agent");
			},
		});
		const out = await r.svc.dispatch(prepared.operation.operationId, edge);
		expect(out).toEqual({ refused: "agent_not_found" });
		const op = r.resps.getOperation(prepared.operation.operationId)!;
		expect(op.state).toBe("refused");
		expect(op.refusal).toBe("agent_not_found");
		r.store.close();
	});

	test("an attachment with no harness-session identity cannot dispatch", async () => {
		const r = rig();
		const { responsibility } = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "h1",
			understanding: understanding(),
			attachments: [{ target: target({ agentSession: null }), baseline: {} }],
		});
		const att = r.resps.attachmentsFor(responsibility.responsibilityId)[0]!;
		const prepared = r.resps.prepareOperation({
			responsibilityId: responsibility.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		let calls = 0;
		const out = await r.svc.dispatch(prepared.operation.operationId, async () => {
			calls += 1;
			return {};
		});
		expect(out).toEqual({ refused: "identity-unenforceable" });
		expect(calls).toBe(0);
		expect(r.resps.getOperation(prepared.operation.operationId)!.state).toBe("refused");
		r.store.close();
	});
});

describe("correct", () => {
	const acceptRig = (r: ReturnType<typeof rig>) =>
		r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "k1",
			understanding: understanding(),
			attachments: [],
		}).responsibility;

	test("text and understanding together bump revision once and emit one event", () => {
		const r = rig();
		const resp = acceptRig(r);
		const revised = r.svc.correct(resp.responsibilityId, {
			text: "watch the flaky test",
			understanding: { ...understanding(), nextAction: "rerun it" },
		});
		expect(revised.revision).toBe(resp.revision + 1);
		const rows = r.store.db
			.query<{ kind: string; text: string; facts_json: string }, []>(
				"SELECT kind, text, facts_json FROM work_events WHERE kind = 'operator-correction'",
			)
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.kind).toBe("operator-correction");
		expect(rows[0]!.text).toBe("watch the flaky test");
		const facts = JSON.parse(rows[0]!.facts_json) as {
			responsibilityId: string;
			revision: number;
			understanding: { nextAction: string };
		};
		expect(facts.responsibilityId).toBe(resp.responsibilityId);
		expect(facts.revision).toBe(resp.revision + 1);
		expect(facts.understanding.nextAction).toBe("rerun it");
		expect(r.pumps).toBeGreaterThanOrEqual(1);
		r.store.close();
	});

	test("text-only still bumps revision; understanding-only emits the exact composed text", () => {
		const r = rig();
		const resp = acceptRig(r);
		const r1 = r.svc.correct(resp.responsibilityId, { text: "comment" });
		expect(r1.revision).toBe(resp.revision + 1);
		const r2 = r.svc.correct(resp.responsibilityId, {
			understanding: { ...understanding(), outcome: "new outcome" },
		});
		expect(r2.revision).toBe(resp.revision + 2);
		const texts = r.store.db
			.query<{ text: string }, []>(
				"SELECT text FROM work_events WHERE kind = 'operator-correction' ORDER BY event_id",
			)
			.all();
		expect(texts).toHaveLength(2);
		expect(texts[0]!.text).toBe("comment");
		expect(texts[1]!.text).toBe(
			`Responsibility understanding corrected:\n${JSON.stringify(r2.understanding)}`,
		);
		r.store.close();
	});

	test("an empty correction is rejected", () => {
		const r = rig();
		const resp = acceptRig(r);
		expect(() => r.svc.correct(resp.responsibilityId, {})).toThrow(/nothing to correct/);
		r.store.close();
	});

	test("a failed event insert rolls the revision back atomically", () => {
		const r = rig();
		const resp = acceptRig(r);
		const before = r.pumps;
		r.store.db.exec(
			"CREATE TEMP TRIGGER no_events BEFORE INSERT ON work_events BEGIN SELECT RAISE(ABORT,'blocked'); END",
		);
		expect(() => r.svc.correct(resp.responsibilityId, { text: "never" })).toThrow();
		r.store.db.exec("DROP TRIGGER no_events");
		expect(r.resps.get(resp.responsibilityId)!.revision).toBe(resp.revision);
		expect(
			r.store.db
				.query("SELECT COUNT(*) AS n FROM work_events WHERE kind = 'operator-correction'")
				.get(),
		).toEqual({ n: 0 });
		expect(r.pumps).toBe(before);
		r.store.close();
	});
});

describe("dispatch pre-send revalidation", () => {
	const prepRig = () => {
		const r = rig();
		const resp = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "k1",
			understanding: understanding(),
			attachments: [
				{
					target: {
						server: "local",
						session: "default",
						agentName: "w1:p1",
						paneId: "w1:p1",
						terminalId: "term-9",
						agentSession: "sess-1",
						kind: "pi",
						cwd: "/w",
					},
					baseline: {},
				},
			],
		}).responsibility;
		const att = r.resps.attachmentsFor(resp.responsibilityId)[0]!;
		const prepared = r.resps.prepareOperation({
			responsibilityId: resp.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		return { r, resp, att, op: prepared.operation };
	};

	test("a mid-preflight correction refuses with the named refusal", async () => {
		const { r, resp, op } = prepRig();
		const send = async (_b: string, _t: unknown, beforeSend?: () => void) => {
			r.resps.revise(resp.responsibilityId, understanding());
			beforeSend?.();
			return {};
		};
		const out = await r.svc.dispatch(op.operationId, send as never);
		expect(out).toEqual({ refused: "stale-revision" });
		expect(r.resps.getOperation(op.operationId)!.state).toBe("refused");
		expect(r.resps.getOperation(op.operationId)!.refusal).toBe("stale-revision");
		r.store.close();
	});

	test("a mid-preflight detach refuses attachment-detached", async () => {
		const { r, att, op } = prepRig();
		const out = await r.svc.dispatch(op.operationId, (async (
			_b: string,
			_t: unknown,
			bs?: () => void,
		) => {
			r.resps.detach(att.attachmentId);
			bs?.();
		}) as never);
		expect(out).toEqual({ refused: "attachment-detached" });
		r.store.close();
	});

	test("an edge refusal lands under its own name, not already-terminal", async () => {
		const { r, op } = prepRig();
		const out = await r.svc.dispatch(op.operationId, (async () => {
			throw new HerdrRefusal("identity_mismatch", "swapped");
		}) as never);
		expect(out).toEqual({ refused: "identity_mismatch" });
		expect(r.resps.getOperation(op.operationId)!.refusal).toBe("identity_mismatch");
		r.store.close();
	});
});

describe("managed send edge", () => {
	const target = (over: Record<string, unknown> = {}) =>
		({
			server: "local",
			session: "default",
			agentName: "w1:p1",
			paneId: "w1:p1",
			terminalId: "term-9",
			agentSession: "sess-1",
			kind: "pi",
			cwd: "/w",
			...over,
		}) as unknown as AttachmentTarget;
	const reported = (over: Partial<OperatorAgent> = {}): OperatorAgent => ({
		pane_id: "w1:p1",
		workspace_id: "w1",
		tab_id: "t1",
		agent: "pi",
		agent_status: "working",
		cwd: "/w",
		terminal_title: null,
		workspace_label: null,
		tab_label: null,
		terminal_id: "term-9",
		agent_session: "sess-1",
		state_change_seq: 2,
		completion_seq: null,
		revision: 1,
		...over,
	});

	test("the bound identity and beforeSend reach the prompt guard", async () => {
		const calls: unknown[] = [];
		const edge = makeManagedSendEdge({
			prompt: async (_p, _k, _t, _s, guard) => {
				calls.push(guard);
				guard?.beforeSend?.();
				return reported();
			},
		});
		const out = await edge("brief", target(), () => calls.push("beforeSend"));
		expect(out).toEqual({ reportedAgentSession: "sess-1" });
		expect(calls).toEqual([
			{
				identity: { terminalId: "term-9", agentSession: "sess-1" },
				beforeSend: expect.any(Function),
			},
			"beforeSend",
		]);
	});

	test("absent bound session refuses; post-send session or terminal swap is uncertain", async () => {
		const edge = makeManagedSendEdge({ prompt: async () => reported() });
		await expect(edge("b", target({ agentSession: null }))).rejects.toMatchObject({
			code: "identity-unenforceable",
		});
		const swap = makeManagedSendEdge({ prompt: async () => reported({ agent_session: "sess-2" }) });
		await expect(swap("b", target())).rejects.toThrow(/post-send identity mismatch/);
		const missing = makeManagedSendEdge({ prompt: async () => reported({ agent_session: null }) });
		await expect(missing("b", target())).rejects.toThrow(/post-send identity mismatch/);
		const termSwap = makeManagedSendEdge({
			prompt: async () => reported({ terminal_id: "term-X" }),
		});
		await expect(termSwap("b", target())).rejects.toThrow(/post-send identity mismatch/);
	});
});

describe("ensureFollowup enable semantics", () => {
	const acceptRig = (r: ReturnType<typeof rig>) =>
		r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "k1",
			understanding: understanding(),
			attachments: [],
		}).responsibility;

	test("a manually disabled program stays disabled on a normal ensure; enable:true re-arms the same row", () => {
		const r = rig();
		const resp = acceptRig(r);
		const program = r.svc.ensureFollowup(resp.responsibilityId)!;
		r.programs.update(program.id, { enabled: false });
		const again = r.svc.ensureFollowup(resp.responsibilityId)!;
		expect(again.id).toBe(program.id);
		expect(again.enabled).toBe(false);
		expect(r.resps.get(resp.responsibilityId)!.armed).toBe(false);
		expect(r.resps.get(resp.responsibilityId)!.notArmedReason).toBe("follow-up program disabled");
		const re = r.svc.ensureFollowup(resp.responsibilityId, { enable: true })!;
		expect(re.id).toBe(program.id);
		expect(re.enabled).toBe(true);
		expect(re.nextRun).not.toBeNull();
		expect(r.resps.get(resp.responsibilityId)!.armed).toBe(true);
		r.store.close();
	});

	test("an inactive responsibility reports not armed without touching the program", () => {
		const r = rig();
		const resp = acceptRig(r);
		const program = r.svc.ensureFollowup(resp.responsibilityId)!;
		r.resps.setStatus(resp.responsibilityId, "paused");
		r.svc.ensureFollowup(resp.responsibilityId);
		expect(r.resps.get(resp.responsibilityId)!.armed).toBe(false);
		expect(r.resps.get(resp.responsibilityId)!.notArmedReason).toBe("responsibility paused");
		expect(r.programs.get(program.id)!.enabled).toBe(true);
		r.store.close();
	});

	test("a link to another responsibility's program is not reused", () => {
		const r = rig();
		const resp = acceptRig(r);
		const foreign = r.programs.create({
			name: "foreign",
			charter: "c",
			cron: "* * * * *",
			responsibilityId: "resp-other",
		});
		r.resps.setFollowup(resp.responsibilityId, String(foreign.id));
		const program = r.svc.ensureFollowup(resp.responsibilityId)!;
		expect(program.id).not.toBe(foreign.id);
		expect(program.responsibilityId).toBe(resp.responsibilityId);
		r.store.close();
	});
});

describe("beforeSend at the real wire surface", () => {
	test("a correction landing during agent-get preflight refuses before any send", async () => {
		const r = rig();
		const resp = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "k1",
			understanding: understanding(),
			attachments: [
				{
					target: {
						server: "local",
						session: "default",
						agentName: "w1:p1",
						paneId: "w1:p1",
						terminalId: "term-9",
						agentSession: "sess-1",
						kind: "pi",
						cwd: "/w",
					},
					baseline: {},
				},
			],
		}).responsibility;
		const att = r.resps.attachmentsFor(resp.responsibilityId)[0]!;
		const prepared = r.resps.prepareOperation({
			responsibilityId: resp.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		const calls: string[] = [];
		let releaseGet!: () => void;
		const gate = new Promise<void>((res) => {
			releaseGet = res;
		});
		const agent = {
			agent: "pi",
			agent_status: "working",
			pane_id: "w1:p1",
			workspace_id: "w1",
			tab_id: "w1:t1",
			terminal_id: "term-9",
			agent_session: { value: "sess-1" },
		};
		const wire = (body: unknown): HerdrRunResult => ({
			code: 0,
			stdout: JSON.stringify(body),
			stderr: "",
		});
		const run = async (args: string[]): Promise<HerdrRunResult> => {
			const verb = args.slice(2, 4).join(" ");
			calls.push(verb);
			if (verb === "workspace list") return wire({ result: { workspaces: [] } });
			if (verb === "agent get") {
				await gate;
				return wire({ result: { agent } });
			}
			if (verb === "agent prompt") return wire({ result: { agent } });
			throw new Error(`unexpected herdr call: ${verb}`);
		};
		const edge = makeManagedSendEdge(makeOperatorHerdr(run));
		const dispatch = r.svc.dispatch(prepared.operation.operationId, edge);
		await waitUntil(() => calls.includes("agent get"), "agent get in flight");
		r.svc.correct(resp.responsibilityId, { text: "stop — direction changed" });
		releaseGet();
		await expect(dispatch).resolves.toEqual({ refused: "stale-revision" });
		expect(calls).not.toContain("agent prompt");
		r.store.close();
	});
});

describe("ensureFollowup without a link", () => {
	const acceptRig2 = (r: ReturnType<typeof rig>) =>
		r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "k1",
			understanding: understanding(),
			attachments: [],
		}).responsibility;

	test("cancel or pause with a dangling link creates no program and reports not armed", () => {
		const r = rig();
		const resp = acceptRig2(r);
		r.resps.setFollowup(resp.responsibilityId, "99999");
		r.resps.setStatus(resp.responsibilityId, "cancelled");
		expect(r.svc.ensureFollowup(resp.responsibilityId, { enable: false })).toBeNull();
		expect(r.resps.get(resp.responsibilityId)!.armed).toBe(false);
		expect(r.resps.get(resp.responsibilityId)!.notArmedReason).toBe("responsibility cancelled");
		const resp2 = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "k2",
			understanding: understanding(),
			attachments: [],
		}).responsibility;
		r.resps.setFollowup(resp2.responsibilityId, "99999");
		r.resps.setStatus(resp2.responsibilityId, "paused");
		expect(r.svc.ensureFollowup(resp2.responsibilityId)).toBeNull();
		expect(r.resps.get(resp2.responsibilityId)!.armed).toBe(false);
		expect(r.resps.get(resp2.responsibilityId)!.notArmedReason).toBe("responsibility paused");
		expect(r.resps.get(resp2.responsibilityId)!.followupProgramId).toBe("99999");
		r.store.close();
	});

	test("an explicit re-enable on a dangling link creates the row fresh", () => {
		const r = rig();
		const resp = acceptRig2(r);
		r.resps.setFollowup(resp.responsibilityId, "99999");
		const program = r.svc.ensureFollowup(resp.responsibilityId, { enable: true })!;
		expect(program.responsibilityId).toBe(resp.responsibilityId);
		expect(program.enabled).toBe(true);
		expect(String(program.id)).not.toBe("99999");
		r.store.close();
	});
});

describe("feed armed derivation", () => {
	test("a directly disabled program reports unarmed with no nextCheckinAt; paused with an enabled row reports none either", () => {
		const r = rig();
		const resp = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "k1",
			understanding: understanding(),
			attachments: [],
		}).responsibility;
		const program = r.svc.ensureFollowup(resp.responsibilityId)!;
		const feed = () =>
			feedForProject({ db: r.store.db, resps: r.resps, programs: r.programs }, r.projectId)[0]!;
		let item = feed();
		expect(item.responsibility.armed).toBe(true);
		expect(item.nextCheckinAt).toBe(program.nextRun);
		r.programs.update(program.id, { enabled: false });
		item = feed();
		expect(item.responsibility.armed).toBe(false);
		expect(item.responsibility.notArmedReason).toBe("follow-up program disabled");
		expect(item.nextCheckinAt).toBeNull();
		r.programs.update(program.id, { enabled: true });
		r.resps.setStatus(resp.responsibilityId, "paused");
		item = feed();
		expect(item.responsibility.armed).toBe(false);
		expect(item.responsibility.notArmedReason).toBe("responsibility paused");
		expect(item.nextCheckinAt).toBeNull();
		r.store.close();
	});
});

describe("atomic dispatch claim", () => {
	const prepRig = () => {
		const r = rig();
		const resp = r.svc.accept({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "k1",
			understanding: understanding(),
			attachments: [
				{
					target: {
						server: "local",
						session: "default",
						agentName: "w1:p1",
						paneId: "w1:p1",
						terminalId: "term-9",
						agentSession: "sess-1",
						kind: "pi",
						cwd: "/w",
					},
					baseline: {},
				},
			],
		}).responsibility;
		const att = r.resps.attachmentsFor(resp.responsibilityId)[0]!;
		const prepared = r.resps.prepareOperation({
			responsibilityId: resp.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		return { r, resp, att, op: prepared.operation };
	};

	test("overlapping dispatch: one edge call wins; the second sees delivery-uncertain without mutating", async () => {
		const { r, op } = prepRig();
		let release!: () => void;
		const gate = new Promise<void>((res) => {
			release = res;
		});
		let calls = 0;
		const send = async () => {
			calls += 1;
			await gate;
			return { wire: "ok" };
		};
		const first = r.svc.dispatch(op.operationId, send);
		await waitUntil(() => r.resps.getOperation(op.operationId)!.state === "sent", "op claimed");
		const second = await r.svc.dispatch(op.operationId, send);
		expect(second).toEqual({ refused: "delivery-uncertain" });
		expect(calls).toBe(1);
		release();
		await expect(first).resolves.toEqual({ sent: true });
		const settled = r.resps.getOperation(op.operationId)!;
		expect(settled.state).toBe("acknowledged");
		expect(settled.outcome).toEqual({ wire: "ok" });
		const third = await r.svc.dispatch(op.operationId, send);
		expect(third).toEqual({ refused: "already-terminal" });
		expect(calls).toBe(1);
		expect(r.resps.getOperation(op.operationId)).toEqual(settled);
		r.store.close();
	});

	test("an uncertain send is never auto-resent — repeat dispatch and a fresh store agree", async () => {
		const { r, op } = prepRig();
		let calls = 0;
		const out = await r.svc.dispatch(op.operationId, async () => {
			calls += 1;
			throw new Error("io died");
		});
		expect(out).toEqual({ refused: "delivery-uncertain" });
		const row = r.resps.getOperation(op.operationId)!;
		expect(row.state).toBe("uncertain");
		expect(row.outcome).toEqual({ error: "io died" });
		const again = await r.svc.dispatch(op.operationId, async () => {
			calls += 1;
			return {};
		});
		expect(again).toEqual({ refused: "delivery-uncertain" });
		expect(calls).toBe(1);
		const store2 = openStore(r.dbPath);
		const resps2 = openResponsibilities(store2.db);
		const svc2 = makeResponsibilityService({
			db: store2.db,
			resps: resps2,
			wakes: openWakeStore(store2.db),
			pump: () => {},
		});
		const reopened = resps2.getOperation(op.operationId)!;
		expect(reopened.state).toBe("uncertain");
		expect(reopened.outcome).toEqual({ error: "io died" });
		const out2 = await svc2.dispatch(op.operationId, async () => {
			calls += 1;
			return {};
		});
		expect(out2).toEqual({ refused: "delivery-uncertain" });
		expect(calls).toBe(1);
		expect(resps2.getOperation(op.operationId)).toEqual(reopened);
		store2.close();
		r.store.close();
	});

	test("a claimed-but-never-acknowledged row is ambiguous delivery, never resent", async () => {
		const { r, op } = prepRig();
		const claim = r.resps.claimForSend(op.operationId);
		if (!("operation" in claim)) throw new Error("expected claim");
		let calls = 0;
		const out = await r.svc.dispatch(op.operationId, async () => {
			calls += 1;
			return {};
		});
		expect(out).toEqual({ refused: "delivery-uncertain" });
		expect(calls).toBe(0);
		expect(r.resps.getOperation(op.operationId)!.state).toBe("sent");
		r.store.close();
	});

	test("two store connections can claim the same op only once", () => {
		const { r, op } = prepRig();
		const db2 = new Database(r.dbPath);
		const resps2 = openResponsibilities(db2);
		const first = r.resps.claimForSend(op.operationId);
		const second = resps2.claimForSend(op.operationId);
		expect("operation" in first).toBe(true);
		expect(second).toEqual({ refused: "already-terminal" });
		expect(resps2.getOperation(op.operationId)!.state).toBe("sent");
		db2.close();
		r.store.close();
	});
});

describe("managed prompt authority after Herdr preflight", () => {
	test.each(["cancel", "revise"] as const)(
		"%s during delayed agent get prevents prompt submission",
		async (change) => {
			const r = rig();
			const resp = r.svc.accept({
				projectId: r.projectId,
				coordinationConversationId: r.convId,
				handoverKey: "delayed-send",
				understanding: understanding(),
				attachments: [{ target: target(), baseline: {} }],
			}).responsibility;
			const att = r.resps.attachmentsFor(resp.responsibilityId)[0]!;
			const calls: string[] = [];
			const signals: (AbortSignal | undefined)[] = [];
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const record = {
				agent: "pi",
				agent_status: "working",
				pane_id: att.target.paneId,
				workspace_id: "w1",
				tab_id: "w1:t1",
				terminal_id: att.target.terminalId,
				agent_session: { value: att.target.agentSession },
			};
			const wire = (body: unknown): HerdrRunResult => ({
				code: 0,
				stdout: JSON.stringify(body),
				stderr: "",
			});
			const run: HerdrRunner = async (args, opts) => {
				const verb = args.slice(2, 4).join(" ");
				calls.push(verb);
				signals.push(opts?.signal);
				if (verb === "workspace list") return wire({ result: { workspaces: [] } });
				if (verb === "agent get") {
					// Deliberately ignore abort here: a successful preflight
					// must still not grant a fenced turn permission to send.
					await gate;
					return wire({ result: { agent: record } });
				}
				if (verb === "agent prompt") return wire({ result: { agent: record } });
				throw new Error(`unexpected Herdr verb: ${verb}`);
			};
			const tool = responsibilityTool({
				resps: r.resps,
				service: r.svc,
				projectId: r.projectId,
				coordinationConversationId: r.convId,
				handoverKey: "delayed-send",
				listFor: async () => [],
				guardedSend: makeManagedSendEdge(makeOperatorHerdr(run)),
			});
			if (tool.execute === undefined) throw new Error("missing execute");
			const abort = new AbortController();
			const pending = tool.execute(
				{
					action: "send",
					responsibility: resp.responsibilityId,
					attachment: att.attachmentId,
					brief: "new brief",
				},
				{ toolCallId: "delayed-send", messages: [], context: {}, abortSignal: abort.signal },
			);
			await waitUntil(() => calls.includes("agent get"), "Herdr preflight entered");
			if (change === "cancel") abort.abort();
			else r.resps.revise(resp.responsibilityId, understanding());
			release();
			await pending;
			expect(calls).toEqual(["workspace list", "agent get"]);
			expect(signals).toEqual([abort.signal, abort.signal]);
			const op = r.resps.operationsFor(resp.responsibilityId)[0]!;
			expect(op.state).toBe(change === "cancel" ? "uncertain" : "refused");
			if (change === "revise") expect(op.refusal).toBe("stale-revision");
			r.store.close();
		},
	);
});
