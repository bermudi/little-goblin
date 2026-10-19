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
import { HerdrRefusal, OPERATOR_SESSION, type OperatorHerdr } from "./herdr.ts";
import { log } from "./log.ts";
import type {
	Attachment,
	AttachmentTarget,
	Responsibility,
	ResponsibilityStore,
	SendRefusal,
	Understanding,
} from "./responsibilities.ts";
import type { WakeStore } from "./wake-store.ts";
import type { Program, ProgramsStore } from "./programs.ts";

export interface ServiceDeps {
	db: Database;
	resps: ResponsibilityStore;
	wakes: WakeStore;
	/** Called after every commit so the durable wake reaches its lane. */
	pump(): void;
	/** Programs owns the check-in's time; the service owns its purpose.
	 *  Absent = the responsibility stays honestly unarmed. */
	programs?: Pick<ProgramsStore, "create" | "get" | "update"> | undefined;
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
	/** Dispatch a prepared operation. The send edge resolves to the
	 *  wire's post-send record; a refusal means nothing was sent. */
	dispatch(operationId: string, send: ManagedSend): Promise<{ sent: true } | { refused: string }>;
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
	return async (brief, target, beforeSend) => {
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
			undefined,
			{
				identity: { terminalId: target.terminalId, agentSession: target.agentSession },
				...(beforeSend !== undefined ? { beforeSend } : {}),
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

	const svc: ResponsibilityService = {
		correct(responsibilityId, input) {
			if (input.text === undefined && input.understanding === undefined) {
				throw new Error("nothing to correct");
			}
			let revised!: Responsibility;
			db.transaction(() => {
				const current = resps.get(responsibilityId);
				if (current === null) throw new Error(`responsibility ${responsibilityId} not found`);
				revised = resps.revise(responsibilityId, input.understanding ?? current.understanding);
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
			pump();
			log.info("responsibility correction", {
				responsibility: responsibilityId,
				revised: input.understanding !== undefined,
				comment: input.text !== undefined,
			});
			return revised;
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
			// Idempotent: a linked row that still exists is reused; a
			// dangling link (program deleted) recreates under a new id.
			if (resp.followupProgramId !== null) {
				const existing = programs.get(Number(resp.followupProgramId));
				if (existing !== null && existing.responsibilityId === resp.responsibilityId) {
					if (opts?.enable !== undefined && existing.enabled !== opts.enable) {
						const updated = programs.update(existing.id, { enabled: opts.enable });
						if (updated === null) {
							throw new Error(
								`follow-up program ${existing.id} update failed for responsibility ${responsibilityId}`,
							);
						}
						return arm(updated);
					}
					return arm(existing);
				}
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
					// Observation arms itself from the attachment rows;
					// ensureFollowup links the follow-up Program and arms —
					// or leaves a named reason when it can't.
					resps.setArmed(
						responsibility.responsibilityId,
						false,
						"follow-up program not yet linked",
					);
					svc.ensureFollowup(responsibility.responsibilityId);
				}
				outcome = { responsibility, created };
			})();
			pump();
			// Re-read — setArmed inside the transaction postdates the
			// create snapshot.
			return {
				responsibility: resps.get(outcome!.responsibility.responsibilityId)!,
				created: outcome!.created,
			};
		},

		async dispatch(operationId, send) {
			const check = resps.validateForSend(operationId);
			if ("refused" in check) {
				resps.transitionOperation(operationId, "refused", { refusal: check.refused });
				log.info("managed send refused pre-dispatch", {
					operation: operationId,
					refusal: check.refused,
				});
				return { refused: check.refused };
			}
			const op = resps.getOperation(operationId);
			if (op === null) return { refused: "responsibility-missing" };
			const att = resps.getAttachment(op.attachmentId);
			if (att === null) return { refused: "attachment-detached" };
			// agent_session is the replacement detector — without it the
			// send edge cannot bind identity, and check-then-send is a race.
			if (att.target.agentSession === null) {
				resps.transitionOperation(operationId, "refused", {
					refusal: "identity-unenforceable",
				});
				log.warn("managed send refused: no harness session identity to bind", {
					operation: operationId,
					attachment: att.attachmentId,
				});
				return { refused: "identity-unenforceable" };
			}
			const recheck = () => {
				const again = resps.validateForSend(operationId);
				if ("refused" in again) {
					throw new HerdrRefusal(again.refused, `send aborted at the wire: ${again.refused}`);
				}
			};
			try {
				recheck();
				const outcome = await send(op.brief, att.target, recheck);
				resps.transitionOperation(operationId, "sent", { outcome });
				resps.transitionOperation(operationId, "acknowledged", { outcome });
				return { sent: true };
			} catch (err) {
				// A refusal is a pre-send verdict — nothing left this host.
				if (err instanceof HerdrRefusal) {
					resps.transitionOperation(operationId, "refused", { refusal: err.code });
					log.info("managed send refused by the edge", {
						operation: operationId,
						refusal: err.code,
					});
					return { refused: err.code };
				}
				// Any other post-dispatch error: the send may have landed —
				// uncertain delivery is evidence to reconcile, never
				// permission to send again.
				resps.transitionOperation(operationId, "uncertain", {
					outcome: { error: err instanceof Error ? err.message : String(err) },
				});
				log.error("managed send outcome uncertain", err, { operation: operationId });
				return { refused: "already-terminal" };
			}
		},
	};
	return svc;
}
