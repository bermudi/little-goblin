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
import {
	makeManagedSendEdge,
	makeResponsibilityService,
} from "./responsibility-service.ts";
import { HerdrRefusal, type OperatorAgent } from "./herdr.ts";
import { openPrograms, type ProgramsStore } from "./programs.ts";
import { tmpDir, useHome } from "./testkit.ts";
import { openWakeStore } from "./wake-store.ts";

setLogFile(null);

interface Rig {
	store: ConversationStore;
	resps: ResponsibilityStore;
	programs: ProgramsStore;
	svc: ReturnType<typeof makeResponsibilityService>;
	projectId: string;
	convId: string;
	pumps: number;
}

function rig(): Rig {
	const home = useHome(`goblin-rsvc-${tmpDir().slice(-6)}-`);
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
	const programs = openPrograms(join(home, "state", "programs.sqlite"));
	const r: Rig = {
		store,
		resps,
		programs,
		projectId: project.id,
		convId: conv.id,
		pumps: 0,
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
	session: "op",
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
		expect(again).toEqual({ refused: "already-terminal" });
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
		expect(out).toEqual({ refused: "already-terminal" });
		const op = r.resps.getOperation(prepared.operation.operationId)!;
		expect(op.state).toBe("uncertain");
		// And the same op can never dispatch again.
		const again = await r.svc.dispatch(prepared.operation.operationId, edge);
		expect(again).toEqual({ refused: "already-terminal" });
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
		expect(out).toEqual({ refused: "already-terminal" });
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
		expect(out).toEqual({ refused: "already-terminal" });
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
