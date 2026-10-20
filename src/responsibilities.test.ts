// Responsibility store — the durable contract the handover loop
// stands on: handover-key idempotence, revision-bumping corrections,
// identity-bound attachments with generation fencing, and managed
// prompt operations that refuse by name instead of dispatching stale.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore, type ConversationStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { openProjects, type ProjectStore } from "./projects.ts";
import {
	openResponsibilities,
	type AttachmentTarget,
	type ResponsibilityStore,
	type Understanding,
} from "./responsibilities.ts";
import { tmpDir, useHome } from "./testkit.ts";

setLogFile(null);

interface Rig {
	store: ConversationStore;
	projects: ProjectStore;
	resps: ResponsibilityStore;
	projectId: string;
	convId: string;
}

function rig(): Rig {
	const home = useHome(`goblin-resps-${tmpDir().slice(-6)}-`);
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const projects = openProjects(store);
	const project = projects.create({ name: "rig" });
	const conv = store.resolve({ kind: "app", appId: project.slug, chatId: 0, threadId: 0 }, project.dir);
	store.bindProject(conv.id, project.id);
	const resps = openResponsibilities(store.db);
	return { store, projects, resps, projectId: project.id, convId: conv.id };
}

const understanding = (over: Partial<Understanding> = {}): Understanding => ({
	outcome: "land the fix",
	situation: "agent is mid-task",
	nextAction: "check the diff",
	checkpoints: ["before the publish step"],
	completionEvidence: ["ci green", "diff reviewed"],
	...over,
});

const target = (over: Partial<AttachmentTarget> = {}): AttachmentTarget => ({
	server: "local",
	session: "goblin-probe",
	agentName: "worker-1",
	paneId: "pane-7",
	terminalId: "term-9",
	agentSession: "sess-abc",
	kind: "pi",
	cwd: "/w",
	...over,
});

describe("responsibility store", () => {
	test("handover creates once; a duplicate key returns the same responsibility", () => {
		const r = rig();
		const a = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "handover:m1",
			understanding: understanding(),
		});
		const b = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "handover:m1",
			understanding: understanding({ outcome: "different" }),
		});
		expect(a.created).toBe(true);
		expect(b.created).toBe(false);
		expect(b.responsibility.responsibilityId).toBe(a.responsibility.responsibilityId);
		expect(b.responsibility.outcome).toBe("land the fix"); // not the replay's
		expect(r.resps.open().map((x) => x.responsibilityId)).toEqual([
			a.responsibility.responsibilityId,
		]);
		r.store.close();
	});

	test("a correction bumps revision and carries the new understanding", () => {
		const r = rig();
		const { responsibility } = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "h1",
			understanding: understanding(),
		});
		const revised = r.resps.revise(
			responsibility.responsibilityId,
			understanding({ nextAction: "wait for the checkpoint" }),
		);
		expect(revised.revision).toBe(2);
		expect(revised.understanding.nextAction).toBe("wait for the checkpoint");
		r.store.close();
	});

	test("status closes out of open() and stamps closed_at", () => {
		const r = rig();
		const { responsibility } = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "h1",
			understanding: understanding(),
		});
		r.resps.setStatus(responsibility.responsibilityId, "completed");
		expect(r.resps.open()).toHaveLength(0);
		expect(r.resps.get(responsibility.responsibilityId)!.closedAt).not.toBeNull();
		r.store.close();
	});

	test("detach marks the attachment; reattach bumps generation and resets the cursor", () => {
		const r = rig();
		const { responsibility } = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "h1",
			understanding: understanding(),
		});
		const att = r.resps.attach({
			responsibilityId: responsibility.responsibilityId,
			target: target(),
			baseline: { status: "working", completionSeq: 3 },
			cursor: { completionSeq: 3 },
		});
		expect(att.generation).toBe(1);
		expect(att.health).toBe("attached");
		expect(att.cursor).toEqual({ completionSeq: 3 });
		r.resps.detach(att.attachmentId);
		expect(r.resps.getAttachment(att.attachmentId)!.health).toBe("detached");
		const again = r.resps.reattach(att.attachmentId, target({ agentSession: "sess-new" }), {
			status: "idle",
		});
		expect(again.generation).toBe(2);
		expect(again.health).toBe("attached");
		expect(again.cursor).toBeNull();
		expect(again.target.agentSession).toBe("sess-new");
		r.store.close();
	});

	test("prepared operations refuse stale generation and revision at dispatch", () => {
		const r = rig();
		const { responsibility } = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "h1",
			understanding: understanding(),
		});
		const att = r.resps.attach({
			responsibilityId: responsibility.responsibilityId,
			target: target(),
			baseline: {},
		});
		const prepared = r.resps.prepareOperation({
			responsibilityId: responsibility.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "continue the refactor",
		});
		if (!("operation" in prepared)) throw new Error("expected a prepared operation");
		const op = prepared.operation;
		expect(op.attachmentGeneration).toBe(1);
		expect(op.responsibilityRevision).toBe(1);
		expect(r.resps.validateForSend(op.operationId)).toEqual({ ok: true });
		// A correction between prepare and dispatch refuses the op.
		r.resps.revise(responsibility.responsibilityId, understanding());
		expect(r.resps.validateForSend(op.operationId)).toEqual({ refused: "stale-revision" });
		// So does a reattachment — a replacement never inherits the send.
		const op2 = r.resps.prepareOperation({
			responsibilityId: responsibility.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "second brief",
		});
		if (!("operation" in op2)) throw new Error("expected a prepared operation");
		r.resps.reattach(att.attachmentId, target({ agentSession: "sess-new" }), {});
		expect(r.resps.validateForSend(op2.operation.operationId)).toEqual({
			refused: "stale-generation",
		});
		r.store.close();
	});

	test("a paused or detached responsibility refuses to prepare or dispatch", () => {
		const r = rig();
		const { responsibility } = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "h1",
			understanding: understanding(),
		});
		const att = r.resps.attach({
			responsibilityId: responsibility.responsibilityId,
			target: target(),
			baseline: {},
		});
		r.resps.setStatus(responsibility.responsibilityId, "paused");
		expect(
			r.resps.prepareOperation({
				responsibilityId: responsibility.responsibilityId,
				attachmentId: att.attachmentId,
				brief: "b",
			}),
		).toEqual({ refused: "responsibility-inactive" });
		r.resps.setStatus(responsibility.responsibilityId, "active");
		r.resps.detach(att.attachmentId);
		expect(
			r.resps.prepareOperation({
				responsibilityId: responsibility.responsibilityId,
				attachmentId: att.attachmentId,
				brief: "b",
			}),
		).toEqual({ refused: "attachment-detached" });
		r.store.close();
	});

	test("an acknowledged operation can never dispatch again", () => {
		const r = rig();
		const { responsibility } = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "h1",
			understanding: understanding(),
		});
		const att = r.resps.attach({
			responsibilityId: responsibility.responsibilityId,
			target: target(),
			baseline: {},
		});
		const prepared = r.resps.prepareOperation({
			responsibilityId: responsibility.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		if (!("operation" in prepared)) throw new Error("expected a prepared operation");
		const id = prepared.operation.operationId;
		r.resps.transitionOperation(id, "sent", { runId: "run-1", toolCallId: "tc-1" });
		expect(r.resps.getOperation(id)!.sentAt).not.toBeNull();
		r.resps.transitionOperation(id, "acknowledged", { outcome: { status: "accepted" } });
		// A replayed acknowledgement under a new tool-call ID meets
		// already-terminal — the recorded send outcome stands.
		expect(r.resps.validateForSend(id)).toEqual({ refused: "already-terminal" });
		expect(r.resps.getOperation(id)!.state).toBe("acknowledged");
		r.store.close();
	});
});

describe("attachment scoping", () => {
	test("prepare refuses an attachment bound to a different responsibility", () => {
		const r = rig();
		const a = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "ka",
			understanding: understanding(),
		}).responsibility;
		const b = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "kb",
			understanding: understanding(),
		}).responsibility;
		const att = r.resps.attach({
			responsibilityId: a.responsibilityId,
			target: target(),
			baseline: {},
		});
		const out = r.resps.prepareOperation({
			responsibilityId: b.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		expect(out).toEqual({ refused: "attachment-mismatch" });
		r.store.close();
	});

	test("a legacy mismatched operation row refuses at validateForSend", () => {
		const r = rig();
		const a = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "ka",
			understanding: understanding(),
		}).responsibility;
		const b = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "kb",
			understanding: understanding(),
		}).responsibility;
		const att = r.resps.attach({
			responsibilityId: a.responsibilityId,
			target: target(),
			baseline: {},
		});
		const prepared = r.resps.prepareOperation({
			responsibilityId: a.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		if (!("operation" in prepared)) throw new Error("expected a prepared operation");
		r.store.db.run("UPDATE prompt_operations SET responsibility_id = ? WHERE operation_id = ?", [
			b.responsibilityId,
			prepared.operation.operationId,
		]);
		expect(r.resps.validateForSend(prepared.operation.operationId)).toEqual({
			refused: "attachment-mismatch",
		});
		r.store.close();
	});

	test("a missing operation row refuses by its own name, not the responsibility's", () => {
		const r = rig();
		expect(r.resps.validateForSend("op-nonexistent")).toEqual({
			refused: "operation-missing",
		});
		r.store.close();
	});
});

describe("operation state machine and atomic claim", () => {
	const prep = (r: ReturnType<typeof rig>) => {
		const resp = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: `k-${Math.random()}`,
			understanding: understanding(),
		}).responsibility;
		const att = r.resps.attach({
			responsibilityId: resp.responsibilityId,
			target: target(),
			baseline: {},
		});
		const prepared = r.resps.prepareOperation({
			responsibilityId: resp.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		return { resp, att, op: prepared.operation };
	};

	test("claimForSend validates and moves prepared → sent exactly once", () => {
		const r = rig();
		const { op } = prep(r);
		const first = r.resps.claimForSend(op.operationId);
		if (!("operation" in first)) throw new Error("expected claim");
		expect(first.operation.state).toBe("sent");
		expect(first.operation.sentAt).not.toBeNull();
		expect(r.resps.claimForSend(op.operationId)).toEqual({ refused: "already-terminal" });
		expect(r.resps.validateForSend(op.operationId)).toEqual({ refused: "already-terminal" });
		expect(r.resps.validateForSend(op.operationId, "sent")).toEqual({ ok: true });
		r.store.close();
	});

	test("a correction between prepare and claim makes the claim refuse", () => {
		const r = rig();
		const { resp, op } = prep(r);
		r.resps.revise(resp.responsibilityId, understanding());
		expect(r.resps.claimForSend(op.operationId)).toEqual({ refused: "stale-revision" });
		expect(r.resps.getOperation(op.operationId)!.state).toBe("prepared");
		r.store.close();
	});

	test("terminal evidence cannot be overwritten; same-state is a no-op", () => {
		const r = rig();
		const { op } = prep(r);
		r.resps.transitionOperation(op.operationId, "sent", { outcome: { wire: "x" } });
		r.resps.transitionOperation(op.operationId, "acknowledged", {
			outcome: { status: "accepted" },
		});
		expect(() => r.resps.transitionOperation(op.operationId, "refused", { refusal: "x" })).toThrow(
			/not a legal operation transition/,
		);
		expect(() => r.resps.transitionOperation(op.operationId, "sent")).toThrow(
			/not a legal operation transition/,
		);
		const row = r.resps.getOperation(op.operationId)!;
		expect(row.state).toBe("acknowledged");
		expect(row.outcome).toEqual({ status: "accepted" });
		r.resps.transitionOperation(op.operationId, "acknowledged", { outcome: { status: "other" } });
		expect(r.resps.getOperation(op.operationId)!.outcome).toEqual({ status: "accepted" });
		const { op: op2 } = prep(r);
		r.resps.transitionOperation(op2.operationId, "sent");
		r.resps.transitionOperation(op2.operationId, "uncertain", { outcome: { error: "io" } });
		expect(() =>
			r.resps.transitionOperation(op2.operationId, "acknowledged", { outcome: {} }),
		).toThrow(/not a legal operation transition/);
		expect(r.resps.getOperation(op2.operationId)!.state).toBe("uncertain");
		r.store.close();
	});

	test("prepare stamps journal run and tool-call linkage", () => {
		const r = rig();
		const resp = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "kl",
			understanding: understanding(),
		}).responsibility;
		const att = r.resps.attach({
			responsibilityId: resp.responsibilityId,
			target: target(),
			baseline: {},
		});
		const prepared = r.resps.prepareOperation({
			responsibilityId: resp.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
			journalRunId: "run-9",
			toolCallId: "tc-9",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		expect(prepared.operation.journalRunId).toBe("run-9");
		expect(prepared.operation.toolCallId).toBe("tc-9");
		r.store.close();
	});

	test("a coordination conversation refuses deletion while its responsibility stands", () => {
		const r = rig();
		const { responsibilityId } = r.resps.create({
			projectId: r.projectId,
			coordinationConversationId: r.convId,
			handoverKey: "kl",
			understanding: understanding(),
		}).responsibility;
		expect(() => r.store.deleteConversation(r.convId)).toThrow(responsibilityId);
		// The refusal names the state and keeps the row — a closed record
		// anchors its surface just as firmly.
		expect(r.store.get(r.convId)).not.toBeNull();
		r.resps.setStatus(responsibilityId, "completed");
		expect(() => r.store.deleteConversation(r.convId)).toThrow("completed");
		expect(r.store.get(r.convId)).not.toBeNull();
		// A conversation that anchors nothing deletes cleanly.
		const free = r.store.resolve({ kind: "dm", chatId: 4 }, "/w");
		r.store.deleteConversation(free.id);
		expect(r.store.get(free.id)).toBeNull();
		r.store.close();
	});
});
