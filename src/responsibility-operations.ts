import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { log } from "./log.ts";
import {
	OP_EDGES,
	ReconciliationConflict,
	type Attachment,
	type OperationState,
	type PromptOperation,
	type Responsibility,
	type SendRefusal,
} from "./responsibility-types.ts";
import { opRowSchema, type OpRow, toOperation } from "./responsibility-schema.ts";

// The prompt-operation methods of openResponsibilities (#466), moved
// out of its closure. The parent owns the shared state; read it through
// deps accessors rather than capturing a snapshot.
export interface OperationsDeps {
	db: Database;
	now(): string;
	requireAtt(attachmentId: number): Attachment;
	checkSendable(resp: Responsibility | null, att: Attachment | null): SendRefusal | null;
	store(): {
		get(id: string): Responsibility | null;
		getAttachment(id: number): Attachment | null;
		getOperation(id: string): PromptOperation | null;
		transitionOperation(
			id: string,
			to: OperationState,
			opts?: { from?: OperationState },
		): void;
		validateForSend(
			id: string,
			expectedState?: "prepared" | "sent",
		): { ok: true } | { refused: SendRefusal };
	};
}

export function makeOperations(deps: OperationsDeps) {
	const { db } = deps;
	const qInsertOp = db.prepare(
		`INSERT INTO prompt_operations (operation_id, responsibility_id, attachment_id, attachment_generation, responsibility_revision, dispatch_server, dispatch_session, dispatch_terminal_id, dispatch_agent_session, dispatch_kind, brief, state, journal_run_id, tool_call_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)`,
	);
	const qOp = db.query<OpRow, [string]>("SELECT * FROM prompt_operations WHERE operation_id = ?");
	const qOpsFor = db.query<OpRow, [string]>(
		"SELECT * FROM prompt_operations WHERE responsibility_id = ? ORDER BY created_at",
	);
	// The boot crash sweep — a `sent` row no live dispatch owns.
	const qSentOpIds = db.query<{ operation_id: string }, []>(
		"SELECT operation_id FROM prompt_operations WHERE state = 'sent' ORDER BY created_at",
	);
	// The unresolved-delivery guard: an operation that reached the wire
	// (sent) or lost its outcome (uncertain) blocks every new send to
	// the same attachment generation until reconciled.
	const qUnresolved = db.query<OpRow, [number, number]>(
		"SELECT * FROM prompt_operations WHERE attachment_id = ? AND attachment_generation = ? AND state IN ('sent','uncertain') ORDER BY created_at LIMIT 1",
	);
	// The same guard against the detach→attach route: a fresh bind mints
	// a new attachment id and generation, so only the operation's own
	// dispatch identity (server, session, terminal, harness session,
	// kind) can recognize it as the same destination. The identity is
	// the operation's own snapshot — the attachment row's copies are
	// rewritten by every reattach, so reading them would re-key an
	// unresolved send onto whatever destination the row holds now.
	// `IS` keeps NULL identity fields comparable.
	const qUnresolvedForIdentity = db.query<
		OpRow,
		[string, string, string, string | null, string | null, string | null]
	>(
		`SELECT o.* FROM prompt_operations o
		 WHERE o.responsibility_id = ? AND o.state IN ('sent','uncertain')
		   AND o.dispatch_server IS ? AND o.dispatch_session IS ?
		   AND o.dispatch_terminal_id IS ? AND o.dispatch_agent_session IS ? AND o.dispatch_kind IS ?
		 ORDER BY o.created_at LIMIT 1`,
	);
	const qOpClaim = db.prepare(
		`UPDATE prompt_operations SET state = 'sent', sent_at = ? WHERE operation_id = ? AND state = 'prepared'`,
	);
	const qOpTransition = db.prepare(
		`UPDATE prompt_operations SET state = ?, refusal = ?, journal_run_id = COALESCE(?, journal_run_id), tool_call_id = COALESCE(?, tool_call_id), sent_at = COALESCE(?, sent_at), outcome_json = COALESCE(?, outcome_json) WHERE operation_id = ? AND state = ?`,
	);

	const methods = {
		prepareOperation(input: {
			responsibilityId: string;
			attachmentId: number;
			brief: string;
			journalRunId?: string | undefined;
			toolCallId?: string | undefined;
		}) {
			const store = deps.store();
			const resp = store.get(input.responsibilityId);
			const att = store.getAttachment(input.attachmentId);
			const refusal = deps.checkSendable(resp, att);
			if (refusal !== null) return { refused: refusal };
			// Check-and-insert in one transaction: the unresolved-op read
			// and the new row are one atomic step, so a racing claim can
			// never interleave a dispatch between them.
			let prepared:
				| { operation: PromptOperation }
				| { refused: SendRefusal; unresolved: PromptOperation };
			db.transaction(() => {
				// The fence is the dispatch identity, not the row: a duplicate
				// binding of the same agent must not reach the wire around an
				// unresolved send on its sibling.
				const blocked =
					qUnresolved.get(att!.attachmentId, att!.generation) ??
					qUnresolvedForIdentity.get(
						input.responsibilityId,
						att!.target.server,
						att!.target.session,
						att!.target.terminalId,
						att!.target.agentSession,
						att!.target.kind,
					);
				if (blocked !== null) {
					prepared = {
						refused: "delivery-uncertain",
						unresolved: toOperation(opRowSchema.parse(blocked)),
					};
					return;
				}
				const operationId = `op-${randomUUID()}`;
				qInsertOp.run(
					operationId,
					input.responsibilityId,
					input.attachmentId,
					att!.generation,
					resp!.revision,
					att!.target.server,
					att!.target.session,
					att!.target.terminalId,
					att!.target.agentSession,
					att!.target.kind,
					input.brief,
					input.journalRunId ?? null,
					input.toolCallId ?? null,
					deps.now(),
				);
				prepared = { operation: store.getOperation(operationId)! };
			})();
			if ("refused" in prepared!) {
				log.warn("prompt operation refused — unresolved delivery on this attachment", {
					responsibility: input.responsibilityId,
					attachment: input.attachmentId,
					unresolved: prepared!.unresolved.operationId,
				});
				return prepared!;
			}
			const op = prepared!.operation;
			log.info("prompt operation prepared", {
				operation: op.operationId,
				responsibility: input.responsibilityId,
				attachment: input.attachmentId,
				generation: op.attachmentGeneration,
				revision: op.responsibilityRevision,
			});
			return prepared!;
		},
		getOperation: (operationId: string) => {
			const row = qOp.get(operationId);
			return row === null ? null : toOperation(opRowSchema.parse(row));
		},
		operationsFor: (responsibilityId: string) =>
			qOpsFor.all(responsibilityId).map((r) => toOperation(opRowSchema.parse(r))),
		markCrashedSendsUncertain() {
			const ids: string[] = [];
			const store = deps.store();
			db.transaction(() => {
				for (const row of qSentOpIds.all()) {
					// The ordinary transition, not a private write: the log
					// line and the state-machine guard both apply.
					store.transitionOperation(row.operation_id, "uncertain", { from: "sent" });
					ids.push(row.operation_id);
				}
			}).immediate();
			return ids;
		},

		validateForSend(
			operationId: string,
			expectedState: "prepared" | "sent" = "prepared",
		): { ok: true } | { refused: SendRefusal } {
			const row = qOp.get(operationId);
			// A vanished operation row is row-level corruption or a foreign
			// id — its own refusal, never the responsibility's.
			if (row === null) return { refused: "operation-missing" as const };
			const op = toOperation(opRowSchema.parse(row));
			// Operations that must never dispatch — their outcome is already on
			// the record or someone refused them by name.
			if (op.state !== expectedState) return { refused: "already-terminal" as const };
			const store = deps.store();
			const resp = store.get(op.responsibilityId);
			const att = store.getAttachment(op.attachmentId);
			const base = deps.checkSendable(resp, att);
			if (base !== null) return { refused: base };
			if (att!.generation !== op.attachmentGeneration) return { refused: "stale-generation" };
			if (resp!.revision !== op.responsibilityRevision) return { refused: "stale-revision" };
			return { ok: true };
		},

		claimForSend(operationId: string) {
			let out!: { operation: PromptOperation } | { refused: SendRefusal };
			const store = deps.store();
			db.transaction(() => {
				const check = store.validateForSend(operationId);
				if ("refused" in check) {
					out = check;
					return;
				}
				// Two ops prepared before the first claim both validated —
				// the claim is the second fence: once a sibling is sent or
				// uncertain, this prepared op can never dispatch. The fence is
				// the dispatch identity, not the row: a duplicate binding of
				// the same agent is fenced with its sibling's operations.
				const op = store.getOperation(operationId)!;
				// validateForSend just refused a missing attachment in this same
				// transaction — requireAtt's throw is the unreachable-branch alarm.
				const att = deps.requireAtt(op.attachmentId);
				// The fence's candidate is the identity this op dispatches
				// to: its own prepare-time snapshot, which a generation match
				// (checked above) makes identical to the bound row's current
				// target. A pre-snapshot row falls back to that same read.
				const identity = op.dispatch ?? att.target;
				const blocked =
					qUnresolved.get(op.attachmentId, op.attachmentGeneration) ??
					qUnresolvedForIdentity.get(
						op.responsibilityId,
						identity.server,
						identity.session,
						identity.terminalId,
						identity.agentSession,
						identity.kind,
					);
				if (blocked !== null) {
					out = { refused: "delivery-uncertain" };
					return;
				}
				const res = qOpClaim.run(deps.now(), operationId);
				if (res.changes !== 1) {
					out = { refused: "already-terminal" };
					return;
				}
				out = { operation: store.getOperation(operationId)! };
			})();
			if ("operation" in out) {
				log.info("prompt operation claimed for dispatch", {
					operation: operationId,
					responsibility: out.operation.responsibilityId,
					run: out.operation.journalRunId,
				});
			}
			return out;
		},

		transitionOperation(
			operationId: string,
			to: OperationState,
			opts?: {
				refusal?: string;
				runId?: string;
				toolCallId?: string;
				outcome?: unknown;
				from?: OperationState;
			},
		) {
			const row = qOp.get(operationId);
			if (row === null) throw new Error(`prompt operation ${operationId} not found`);
			const from = opRowSchema.parse(row).state;
			if (from === to) return;
			if (opts?.from !== undefined && from !== opts.from) {
				log.info("prompt operation transition skipped — claim already moved", {
					operation: operationId,
					expected: opts.from,
					actual: from,
				});
				return;
			}
			if (!OP_EDGES[from]!.has(to)) {
				throw new Error(
					`prompt operation ${operationId}: ${from} → ${to} is not a legal operation transition`,
				);
			}
			// 'sent' records the dispatch instant; the rest leave sent_at alone.
			const sentAt = to === "sent" ? deps.now() : null;
			const res = qOpTransition.run(
				to,
				opts?.refusal ?? null,
				opts?.runId ?? null,
				opts?.toolCallId ?? null,
				sentAt,
				opts?.outcome === undefined ? null : JSON.stringify(opts.outcome),
				operationId,
				from,
			);
			if (res.changes !== 1) {
				throw new Error(`prompt operation ${operationId}: ${from} → ${to} raced a transition`);
			}
			log.info("prompt operation transition", {
				operation: operationId,
				state: to,
				refusal: opts?.refusal ?? null,
			});
		},

		reconcileOperation(
			operationId: string,
			delivery: "delivered" | "not_delivered",
			evidence: string,
		) {
			const trimmed = evidence.trim();
			if (trimmed === "") {
				throw new Error("reconciliation requires inspected evidence");
			}
			let out!: PromptOperation;
			db.transaction(() => {
				const row = qOp.get(operationId);
				if (row === null) {
					throw new Error(`prompt operation ${operationId} not found`);
				}
				const op = toOperation(opRowSchema.parse(row));
				const prior =
					typeof op.outcome === "object" && op.outcome !== null
						? (op.outcome as Record<string, unknown>)
						: null;
				const existing =
					prior !== null &&
					typeof prior.reconciliation === "object" &&
					prior.reconciliation !== null
						? (prior.reconciliation as Record<string, unknown>)
						: null;
				if (existing !== null) {
					// The recorded verdict is the evidence trail — replaying
					// it verbatim is the idempotent no-op; anything else is a
					// conflict the operator resolves, never an overwrite.
					if (existing.delivery === delivery && existing.evidence === trimmed) {
						out = op;
						return;
					}
					throw new ReconciliationConflict(
						`prompt operation ${operationId} already reconciled as ${String(existing.delivery)}`,
					);
				}
				if (op.state !== "sent" && op.state !== "uncertain") {
					throw new ReconciliationConflict(
						`prompt operation ${operationId} is ${op.state} — only sent/uncertain operations reconcile`,
					);
				}
				const to: OperationState = delivery === "delivered" ? "acknowledged" : "refused";
				// Private CAS — uncertain deliberately has no public edge
				// to a terminal state; only this evidence-gated write may
				// close an ambiguous delivery.
				const res = qOpTransition.run(
					to,
					to === "refused" ? "not-delivered" : null,
					null,
					null,
					null,
					JSON.stringify({
						prior: op.outcome,
						reconciliation: { delivery, evidence: trimmed, at: deps.now() },
					}),
					operationId,
					op.state,
				);
				if (res.changes !== 1) {
					throw new ReconciliationConflict(
						`prompt operation ${operationId} reconciliation raced a settlement`,
						op,
					);
				}
				out = deps.store().getOperation(operationId)!;
			})();
			log.info("prompt operation reconciled", {
				operation: operationId,
				delivery,
				state: out.state,
			});
			return out;
		},
	};
	return { methods, qOpsFor, qUnresolved, qUnresolvedForIdentity };
}
