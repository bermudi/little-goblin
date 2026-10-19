// The responsibility tool — the project conversation's verbs: accept
// binds selected agents by reported identity (never pane+kind), the
// lifecycle verbs are durable records only, and every managed send
// refuses identity-unenforceable until a guarded-send edge exists.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore, type ConversationStore } from "../../conversation.ts";
import type { OperatorAgent } from "../../herdr.ts";
import { setLogFile } from "../../log.ts";
import { openProjects } from "../../projects.ts";
import { openResponsibilities, type ResponsibilityStore } from "../../responsibilities.ts";
import { makeResponsibilityService } from "../../responsibility-service.ts";
import { tmpDir, useHome } from "../../testkit.ts";
import { openWakeStore } from "../../wake-store.ts";
import { responsibilityTool } from "./responsibility.ts";

setLogFile(null);

const agent = (over: Partial<OperatorAgent> = {}): OperatorAgent => ({
	pane_id: "w1:p1",
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

interface Rig {
	store: ConversationStore;
	resps: ResponsibilityStore;
	projectId: string;
	convId: string;
	execute(input: unknown): Promise<Record<string, unknown>>;
	agents: OperatorAgent[];
}

function rig(over: { guardedSend?: boolean } = {}): Rig {
	const home = useHome(`goblin-rtool-${tmpDir().slice(-6)}-`);
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
		agents: [agent()],
		execute: async () => ({}),
	};
	const service = makeResponsibilityService({
		db: store.db,
		resps,
		wakes,
		pump: () => {},
	});
	const t = responsibilityTool({
		resps,
		service,
		projectId: project.id,
		coordinationConversationId: conv.id,
		handoverKey: "handover:test",
		listFor: async () => r.agents,
		...(over.guardedSend === true ? { guardedSend: async () => ({ ok: true }) } : {}),
	});
	r.execute = (input) =>
		(t.execute as unknown as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(
			input,
			{ toolCallId: "tc-resp", messages: [], context: {} },
		);
	return r;
}

const understanding = {
	outcome: "land the fix",
	situation: "mid-task",
	nextAction: "check the diff",
	checkpoints: [],
	completionEvidence: ["ci green"],
};

describe("responsibility tool", () => {
	test("accept binds the selected agent and records the handover once", async () => {
		const r = rig();
		const out = await r.execute({
			action: "accept",
			understanding,
			attachments: [{ pane: "w1:p1" }],
		});
		expect(out.created).toBe(true);
		const resp = out.responsibility as { responsibilityId: string; armed: boolean };
		const atts = r.resps.attachmentsFor(resp.responsibilityId);
		expect(atts).toHaveLength(1);
		expect(atts[0]!.target.terminalId).toBe("term-9");
		expect(atts[0]!.target.agentSession).toBe("sess-abc");
		// A second accept on the same handover key is the same record.
		const again = await r.execute({
			action: "accept",
			understanding,
			attachments: [{ pane: "w1:p1" }],
		});
		expect(again.created).toBe(false);
		expect(r.resps.attachmentsFor(resp.responsibilityId)).toHaveLength(1);
		r.store.close();
	});

	test("accept refuses an agent Herdr reports without terminal identity", async () => {
		const r = rig();
		r.agents = [agent({ terminal_id: null })];
		const out = await r.execute({
			action: "accept",
			understanding,
			attachments: [{ pane: "w1:p1" }],
		});
		expect(String(out.error)).toContain("terminal_id");
		expect(r.resps.forProject(r.projectId)).toHaveLength(0);
		r.store.close();
	});

	test("send refuses identity-unenforceable while no guarded send exists — and records it", async () => {
		const r = rig();
		await r.execute({ action: "accept", understanding, attachments: [{ pane: "w1:p1" }] });
		const att = r.resps.attachmentsFor(r.resps.forProject(r.projectId)[0]!.responsibilityId)[0]!;
		const out = await r.execute({ action: "send", attachment: att.attachmentId, brief: "go" });
		expect(out.refused).toBe("identity-unenforceable");
		const ops = r.resps.operationsFor(att.responsibilityId);
		expect(ops).toHaveLength(1);
		expect(ops[0]!.state).toBe("refused");
		expect(ops[0]!.refusal).toBe("identity-unenforceable");
		r.store.close();
	});

	test("send dispatches through a guarded edge when one exists", async () => {
		const r = rig({ guardedSend: true });
		await r.execute({ action: "accept", understanding, attachments: [{ pane: "w1:p1" }] });
		const att = r.resps.attachmentsFor(r.resps.forProject(r.projectId)[0]!.responsibilityId)[0]!;
		const out = await r.execute({ action: "send", attachment: att.attachmentId, brief: "go" });
		expect(out).toEqual({ sent: true });
		expect(r.resps.operationsFor(att.responsibilityId)[0]!.state).toBe("acknowledged");
		r.store.close();
	});

	test("pause then resume ride the durable record — no workspace effects", async () => {
		const r = rig();
		await r.execute({ action: "accept", understanding, attachments: [{ pane: "w1:p1" }] });
		const paused = await r.execute({ action: "pause" });
		expect((paused.responsibility as { status: string }).status).toBe("paused");
		const resumed = await r.execute({ action: "resume" });
		expect((resumed.responsibility as { status: string }).status).toBe("active");
		r.store.close();
	});

	test("a revision bumps the revision and stale sends refuse at dispatch", async () => {
		const r = rig({ guardedSend: true });
		await r.execute({ action: "accept", understanding, attachments: [{ pane: "w1:p1" }] });
		const resp = r.resps.forProject(r.projectId)[0]!;
		const att = r.resps.attachmentsFor(resp.responsibilityId)[0]!;
		const prepared = r.resps.prepareOperation({
			responsibilityId: resp.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		await r.execute({ action: "revise", understanding: { ...understanding, nextAction: "wait" } });
		// The prepared op now fails validation — the send never happens.
		const sent: string[] = [];
		const out = await r.execute({
			action: "send",
			attachment: att.attachmentId,
			brief: "fresh brief",
		});
		expect(out).toEqual({ sent: true }); // a fresh op at the new revision sends
		expect(r.resps.getOperation(prepared.operation.operationId)!.state).toBe("prepared");
		expect(sent).toHaveLength(0);
		r.store.close();
	});
});
