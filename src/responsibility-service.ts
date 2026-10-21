// Responsibility service — the handover loop's verbs. accept() is one
// transaction: responsibility + identity-bound attachments + the
// durable handover work event, idempotent on the handover key so a
// duplicate handover never doubles attachments or initial actions.
// dispatch() drives a managed prompt operation through its named
// gates: validate → send edge → transition. The production send edge
// (makeManagedSendEdge) is the accepted-risk path: Herdr's own
// preflight binds pane + kind, and the returned post-send identity is
// compared to the bound agent_session — a mid-dispatch swap lands as
// 'uncertain', loudly logged, never a resend. A timeout/IO error after
// dispatch is 'uncertain' for the same reason.

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ConversationStore } from "./conversation.ts";
import { HerdrRefusal, OPERATOR_SESSION, type OperatorHerdr } from "./herdr.ts";
import { log } from "./log.ts";
import {
	ReconciliationConflict,
	armedView,
	type Attachment,
	type AttachmentTarget,
	type PromptOperation,
	type Responsibility,
	type ResponsibilityStore,
	type Understanding,
} from "./responsibilities.ts";
import type { WakeStore } from "./wake-store.ts";
import type { Program, ProgramsStore } from "./programs.ts";

export interface ServiceDeps {
	db: Database;
	resps: ResponsibilityStore;
	wakes: WakeStore;
	/** The same db handle's conversation store — correct() bumps the
	 *  epoch of every conversation bound to the project inside the
	 *  commit so a rollback undoes revision + fences + event together. */
	conversations: Pick<ConversationStore, "bumpEpoch" | "listProjectConversationIds">;
	/** Called after every commit so the durable wake reaches its lane. */
	pump(): void;
	/** Programs owns the check-in's time; the service owns its purpose.
	 *  Absent = the responsibility stays honestly unarmed. */
	programs?: Pick<ProgramsStore, "create" | "get" | "update" | "forResponsibility"> | undefined;
	/** Invoked after the correction commits — the committed epoch in
	 *  hand — and before pump, so the composition fences the live turn
	 *  before the correction wake is admitted. The commit stands either
	 *  way; a hook error surfaces and the wake still pumps. */
	onCorrectionCommitted?:
		| ((conversationId: string, epoch: number) => void)
		| undefined;
}

export interface HandoverInput {
	projectId: string;
	coordinationConversationId: string;
	/** Stable dedupe identity — the operator's handover message. */
	handoverKey: string;
	understanding: Understanding;
	/** Each explicitly selected agent: identity fields as bound, plus
	 *  the observed baseline/cursor snapshot from the acceptance read. */
	attachments: {
		target: AttachmentTarget;
		baseline: unknown;
		cursor?: unknown;
	}[];
}

export type ManagedSend = (
	brief: string,
	target: AttachmentTarget,
	beforeSend?: () => void,
	signal?: AbortSignal,
) => Promise<unknown>;

export interface ResponsibilityService {
	accept(input: HandoverInput): { responsibility: Responsibility; created: boolean };
	correct(
		responsibilityId: string,
		input: { text?: string | undefined; understanding?: Understanding | undefined },
	): Responsibility;
	/** One linked follow-up Program per responsibility — create-once,
	 *  relink if the row vanished. Returns null while programs is
	 *  unwired (the responsibility stays unarmed with the reason). */
	ensureFollowup(responsibilityId: string, opts?: { enable?: boolean }): Program | null;
	/** The arm truth recomputed from the linked program — the same read
	 *  the app feed renders. Persisted armed fields lag a program the
	 *  program tool disabled or deleted behind the responsibility's
	 *  back; agent-facing status must not. */
	armedStatus(responsibilityId: string): { armed: boolean; reason: string | null };
	/** Dispatch a prepared operation. The send edge resolves to the
	 *  wire's post-send record; a refusal means nothing was sent. */
	dispatch(operationId: string, send: ManagedSend): Promise<{ sent: true } | { refused: string }>;
	/** Close a sent/uncertain operation against inspected delivery
	 *  evidence — the escape hatch the unresolved-delivery fence names.
	 *  A live in-process dispatch refuses: its settlement owns the row
	 *  until it lands. */
	reconcile(
		operationId: string,
		delivery: "delivered" | "not_delivered",
		evidence: string,
	): { operation: PromptOperation } | { refused: string; error?: string };
}

// The follow-up's charter: time is the cron's job; this is the purpose
// the occurrence replays into the coordination lane each fire.
const FOLLOWUP_CRON = "*/15 * * * *";
function followupCharter(resp: Responsibility): string {
	return (
		`Scheduled check-in on a handed-over responsibility.\n` +
		`Outcome: ${resp.outcome}\n` +
		`Review the attached agents' observed state and pending developments; ` +
		`if the outcome is evidenced, report and complete; if blocked, surface ` +
		`the blocker; otherwise verify the next action is progressing.`
	);
}

// The managed send edge, built on the real adapter. prompt's own
// preflight refuses a missing/mismatched occupant (nothing sent); the
// agent record it returns is the post-wait identity — comparing it to
// the bound session is the observability the accepted-risk ruling
// asked for. A mismatch throws: dispatch lands the op 'uncertain',
// which is honest — the bytes may have crossed to a replacement and an
// automatic resend would only double the exposure.
export function makeManagedSendEdge(herdr: Pick<OperatorHerdr, "prompt">): ManagedSend {
	return async (brief, target, beforeSend, signal) => {
		signal?.throwIfAborted();
		// The adapter is the operator session on the local server — a
		// target outside that scope would misroute, so it refuses.
		if (target.server !== "local" || target.session !== OPERATOR_SESSION) {
			throw new HerdrRefusal(
				"identity-unenforceable",
				`attachment targets ${target.server}/${target.session} — the send edge covers local/${OPERATOR_SESSION} only`,
			);
		}
		if (target.kind === null) {
			throw new HerdrRefusal("kind_mismatch", "attachment has no agent kind to verify at dispatch");
		}
		if (target.agentSession === null) {
			throw new HerdrRefusal(
				"identity-unenforceable",
				"attachment has no harness session identity to bind",
			);
		}
		const reported = await herdr.prompt(
			target.paneId ?? target.agentName,
			target.kind,
			brief,
			signal,
			{
				identity: { terminalId: target.terminalId, agentSession: target.agentSession },
				beforeSend: () => {
					// Preflight awaits Herdr; a stopped turn must not regain
					// authority just because that read eventually succeeded.
					signal?.throwIfAborted();
					beforeSend?.();
				},
			},
		);
		if (
			reported.agent_session !== target.agentSession ||
			(target.terminalId !== null && reported.terminal_id !== target.terminalId)
		) {
			log.error(
				"managed send crossed an identity change — prompt may have landed on a replacement",
				undefined,
				{
					pane: reported.pane_id,
					bound: { terminalId: target.terminalId, agentSession: target.agentSession },
					reported: {
						terminalId: reported.terminal_id,
						agentSession: reported.agent_session,
					},
				},
			);
			throw new Error(
				`post-send identity mismatch: bound ${target.agentSession}, pane reported ${reported.agent_session}`,
			);
		}
		return { reportedAgentSession: reported.agent_session };
	};
}

export function makeResponsibilityService(deps: ServiceDeps): ResponsibilityService {
	const { db, resps, wakes, pump } = deps;
	// Operations with a live in-process dispatch — reconcile refuses
	// them while their settlement is still owed.
	const inflight = new Set<string>();

	const svc: ResponsibilityService = {
		correct(responsibilityId, input) {
			if (input.text === undefined && input.understanding === undefined) {
				throw new Error("nothing to correct");
			}
			let revised!: Responsibility;
			const epochs = new Map<string, number>();
			db.transaction(() => {
				const current = resps.get(responsibilityId);
				if (current === null) throw new Error(`responsibility ${responsibilityId} not found`);
				revised = resps.revise(responsibilityId, input.understanding ?? current.understanding);
				// The operator's word outranks anything in flight — in ANY
				// lane of this project, since every bound conversation can
				// reach the coordination tools. Bump them all in the same
				// commit: a rollback undoes revision + fences + event.
				const lanes = new Set(
					deps.conversations.listProjectConversationIds(current.projectId),
				);
				lanes.add(current.coordinationConversationId);
				for (const id of lanes) {
					epochs.set(id, deps.conversations.bumpEpoch(id));
				}
				wakes.record({
					sourceKey: `correction:${responsibilityId}:${randomUUID()}`,
					conversationId: current.coordinationConversationId,
					kind: "operator-correction",
					text:
						input.text ??
						`Responsibility understanding corrected:\n${JSON.stringify(revised.understanding)}`,
					facts: {
						responsibilityId,
						revision: revised.revision,
						understanding: revised.understanding,
					},
					origin: "operator",
					responsibilityId,
				});
			})();
			// Every fenced lane gets its cancellation before the wake
			// pumps — a hook failure on one lane never skips the rest.
			let firstHookError: { error: unknown } | null = null;
			for (const [convId, epoch] of epochs) {
				try {
					deps.onCorrectionCommitted?.(convId, epoch);
				} catch (err) {
					firstHookError ??= { error: err };
					log.error("correction commit hook failed", err, {
						responsibility: responsibilityId,
						conversation: convId,
						epoch,
					});
				}
			}
			pump();
			if (firstHookError !== null) throw firstHookError.error;
			log.info("responsibility correction", {
				responsibility: responsibilityId,
				revised: input.understanding !== undefined,
				comment: input.text !== undefined,
			});
			return revised;
		},

		armedStatus(responsibilityId) {
			const resp = resps.get(responsibilityId);
			if (resp === null) return { armed: false, reason: "responsibility missing" };
			return armedView(resp, deps.programs);
		},

		ensureFollowup(responsibilityId, opts) {
			const resp = resps.get(responsibilityId);
			if (resp === null) return null;
			const programs = deps.programs;
			if (programs === undefined) {
				resps.setArmed(responsibilityId, false, "programs store unavailable");
				return null;
			}
			const arm = (program: Program): Program => {
				const armed = program.enabled && resp.status === "active";
				resps.setArmed(
					responsibilityId,
					armed,
					armed
						? null
						: !program.enabled
							? "follow-up program disabled"
							: `responsibility ${resp.status}`,
				);
				return program;
			};
			// Enable-flag settling shared by the linked and adopted rows.
			const settleEnable = (program: Program): Program => {
				if (opts?.enable !== undefined && program.enabled !== opts.enable) {
					const updated = programs.update(program.id, { enabled: opts.enable });
					if (updated === null) {
						throw new Error(
							`follow-up program ${program.id} update failed for responsibility ${responsibilityId}`,
						);
					}
					return updated;
				}
				return program;
			};
			// Idempotent: a linked row that still exists is reused; a
			// dangling link (program deleted) recreates under a new id.
			if (resp.followupProgramId !== null) {
				const existing = programs.get(Number(resp.followupProgramId));
				if (existing !== null && existing.responsibilityId === resp.responsibilityId) {
					return arm(settleEnable(existing));
				}
			}
			// Recovery: programs.create commits before setFollowup links it —
			// a crash or failed link write leaves an enabled, unlinked
			// program that a plain recreate would twin (both eligible to
			// fire; disabling the linked one leaves the orphan running).
			// The responsibility binding is the durable identity: adopt the
			// oldest orphan and silence any extras.
			const orphans = programs.forResponsibility(resp.responsibilityId);
			if (orphans.length > 0) {
				const orphan = orphans[0]!;
				for (const extra of orphans.slice(1)) {
					programs.update(extra.id, { enabled: false });
					log.error("responsibility follow-up twin disabled — one program per responsibility", {
						responsibility: responsibilityId,
						program: extra.id,
					});
				}
				resps.setFollowup(responsibilityId, String(orphan.id));
				const program = arm(settleEnable(orphan));
				log.info("responsibility follow-up program relinked after an unlinked create", {
					responsibility: responsibilityId,
					program: program.id,
					cron: program.cron,
				});
				return program;
			}
			if (opts?.enable === false || resp.status !== "active") {
				resps.setArmed(
					responsibilityId,
					false,
					resp.status === "active" ? "follow-up program disabled" : `responsibility ${resp.status}`,
				);
				return null;
			}
			const program = programs.create({
				name: `followup:${resp.responsibilityId}`,
				charter: followupCharter(resp),
				cron: FOLLOWUP_CRON,
				responsibilityId: resp.responsibilityId,
			});
			resps.setFollowup(responsibilityId, String(program.id));
			arm(program);
			log.info("responsibility follow-up program linked", {
				responsibility: responsibilityId,
				program: program.id,
				cron: FOLLOWUP_CRON,
			});
			return program;
		},

		accept(input) {
			const understanding = input.understanding;
			let outcome: { responsibility: Responsibility; created: boolean };
			db.transaction(() => {
				const { responsibility, created } = resps.create({
					projectId: input.projectId,
					coordinationConversationId: input.coordinationConversationId,
					handoverKey: input.handoverKey,
					understanding,
				});
				if (created) {
					const atts: Attachment[] = input.attachments.map((a) =>
						resps.attach({
							responsibilityId: responsibility.responsibilityId,
							target: a.target,
							baseline: a.baseline,
							...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
						}),
					);
					// The durable handover event — survives a crash before the
					// first coordination turn, feeds the feed and the wake.
					wakes.record({
						sourceKey: `handover:${input.handoverKey}`,
						conversationId: input.coordinationConversationId,
						kind: "handover",
						text: `take over this work: ${understanding.outcome}`,
						facts: {
							understanding,
							attachments: atts.map((a) => ({
								attachmentId: a.attachmentId,
								agent: a.target.agentName,
								terminalId: a.target.terminalId,
								agentSession: a.target.agentSession,
							})),
						},
						origin: "operator",
						responsibilityId: responsibility.responsibilityId,
					});
					// The unarmed baseline — durable inside the commit so a
					// post-commit link failure (or a crash between them)
					// still names why follow-through is off. ensureFollowup
					// upgrades this row or rewrites the reason.
					resps.setArmed(
						responsibility.responsibilityId,
						false,
						"follow-up program not yet linked",
					);
				}
				outcome = { responsibility, created };
			})();
			// ensureFollowup writes through the programs store's own
			// connection to this same file — inside the transaction that
			// nested write is a guaranteed SQLITE_BUSY and would roll the
			// handover back with it. Post-commit, a link failure only
			// leaves the responsibility unarmed; the boot relink sweep
			// retries it.
			if (outcome!.created) {
				try {
					svc.ensureFollowup(outcome!.responsibility.responsibilityId);
				} catch (err) {
					log.error("responsibility follow-up link failed", err, {
						responsibility: outcome!.responsibility.responsibilityId,
					});
				}
			}
			pump();
			// Re-read — the armed/follow-up writes postdate the create
			// snapshot.
			return {
				responsibility: resps.get(outcome!.responsibility.responsibilityId)!,
				created: outcome!.created,
			};
		},

		async dispatch(operationId, send) {
			const op = resps.getOperation(operationId);
			// Row-level corruption or a foreign id — its own refusal, never
			// the responsibility's.
			if (op === null) return { refused: "operation-missing" };
			if (op.state === "sent" || op.state === "uncertain") {
				return { refused: "delivery-uncertain" };
			}
			if (op.state !== "prepared") return { refused: "already-terminal" };
			const check = resps.validateForSend(operationId);
			if ("refused" in check) {
				resps.transitionOperation(operationId, "refused", {
					refusal: check.refused,
					from: "prepared",
				});
				log.info("managed send refused pre-dispatch", {
					operation: operationId,
					refusal: check.refused,
				});
				return { refused: check.refused };
			}
			const att = resps.getAttachment(op.attachmentId);
			if (att === null) return { refused: "attachment-detached" };
			// agent_session is the replacement detector — without it the
			// send edge cannot bind identity, and check-then-send is a race.
			if (att.target.agentSession === null) {
				resps.transitionOperation(operationId, "refused", {
					refusal: "identity-unenforceable",
					from: "prepared",
				});
				log.warn("managed send refused: no harness session identity to bind", {
					operation: operationId,
					attachment: att.attachmentId,
				});
				return { refused: "identity-unenforceable" };
			}
			// The recorded disposition beats whatever this in-flight edge
			// reports: a reconciliation landed by another process CAS-fences
			// our settlement to 'sent' and stands.
			const disposition = (fallback: string): { sent: true } | { refused: string } => {
				const cur = resps.getOperation(operationId);
				if (cur === null) return { refused: "operation-missing" };
				if (cur.state === "acknowledged") return { sent: true };
				if (cur.state === "refused") return { refused: cur.refusal ?? fallback };
				return { refused: fallback };
			};
			inflight.add(operationId);
			try {
				const claim = resps.claimForSend(operationId);
				if ("refused" in claim) {
					const current = resps.getOperation(operationId);
					if (current !== null && current.state !== "prepared") {
						return current.state === "sent" || current.state === "uncertain"
							? { refused: "delivery-uncertain" }
							: { refused: "already-terminal" };
					}
					return { refused: claim.refused };
				}
				const recheck = () => {
					const again = resps.validateForSend(operationId, "sent");
					if ("refused" in again) {
						throw new HerdrRefusal(again.refused, `send aborted at the wire: ${again.refused}`);
					}
				};
				try {
					recheck();
					const outcome = await send(op.brief, att.target, recheck);
					resps.transitionOperation(operationId, "acknowledged", {
						outcome,
						from: "sent",
					});
					const cur = resps.getOperation(operationId);
					if (cur !== null && cur.state !== "acknowledged") {
						log.warn("managed send settlement superseded by reconciliation", {
							operation: operationId,
							state: cur.state,
						});
					}
					return disposition("delivery-uncertain");
				} catch (err) {
					// A refusal is a pre-send verdict — nothing left this host.
					if (err instanceof HerdrRefusal) {
						resps.transitionOperation(operationId, "refused", {
							refusal: err.code,
							from: "sent",
						});
						log.info("managed send refused by the edge", {
							operation: operationId,
							refusal: err.code,
						});
						return disposition(err.code);
					}
					// Any other post-dispatch error: the send may have landed —
					// uncertain delivery is evidence to reconcile, never
					// permission to send again.
					resps.transitionOperation(operationId, "uncertain", {
						outcome: { error: err instanceof Error ? err.message : String(err) },
						from: "sent",
					});
					const cur = resps.getOperation(operationId);
					if (cur !== null && cur.state !== "uncertain") {
						log.warn("managed send outcome superseded by reconciliation", {
							operation: operationId,
							state: cur.state,
						});
					}
					log.error("managed send outcome uncertain", err, {
						operation: operationId,
					});
					return disposition("delivery-uncertain");
				}
			} finally {
				inflight.delete(operationId);
			}
		},

		reconcile(operationId, delivery, evidence) {
			// A live in-process dispatch owns the row's settlement — a late
			// send callback could otherwise land the very action the
			// reconciliation says never happened. Crashed 'sent' rows are
			// reconcilable: the in-flight set is process-local and empty.
			if (inflight.has(operationId)) {
				log.warn("operation reconciliation refused — dispatch in flight", {
					operation: operationId,
				});
				return { refused: "dispatch-in-flight" };
			}
			try {
				return { operation: resps.reconcileOperation(operationId, delivery, evidence) };
			} catch (err) {
				if (err instanceof ReconciliationConflict) {
					log.info("operation reconciliation refused", {
						operation: operationId,
						error: err.message,
					});
					return { refused: "reconcile-conflict", error: err.message };
				}
				throw err;
			}
		},
	};
	return svc;
}
