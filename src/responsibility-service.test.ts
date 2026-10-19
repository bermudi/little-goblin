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
import { makeResponsibilityService } from "./responsibility-service.ts";
import { tmpDir, useHome } from "./testkit.ts";
import { openWakeStore } from "./wake-store.ts";

setLogFile(null);

interface Rig {
	store: ConversationStore;
	resps: ResponsibilityStore;
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
	const r: Rig = {
		store,
		resps,
		projectId: project.id,
		convId: conv.id,
		pumps: 0,
		svc: makeResponsibilityService({
			db: store.db,
			resps,
			wakes,
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
		expect(responsibility.armed).toBe(false);
		expect(responsibility.notArmedReason).toBe("follow-up program not yet linked");
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
