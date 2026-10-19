// Responsibility service — the handover loop's verbs. accept() is one
// transaction: responsibility + identity-bound attachments + the
// durable handover work event, idempotent on the handover key so a
// duplicate handover never doubles attachments or initial actions.
// dispatch() drives a managed prompt operation through its named
// gates: validate → send edge → transition. The send edge is the
// capability seam — Herdr protocol 23 cannot bind agent_session at
// dispatch, so the production composition wires nothing unattended
// until a capability-advertised guarded send exists; tests drive the
// edge with fakes. A timeout/IO error after dispatch is 'uncertain',
// never a resend.

import type { Database } from "bun:sqlite";
import { HerdrRefusal } from "./herdr.ts";
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

export interface ServiceDeps {
	db: Database;
	resps: ResponsibilityStore;
	wakes: WakeStore;
	/** Called after every commit so the durable wake reaches its lane. */
	pump(): void;
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

export interface ResponsibilityService {
	accept(input: HandoverInput): { responsibility: Responsibility; created: boolean };
	/** Dispatch a prepared operation. The send edge resolves to the
	 *  wire's post-send record; a refusal means nothing was sent. */
	dispatch(
		operationId: string,
		send: (brief: string, target: AttachmentTarget) => Promise<unknown>,
	): Promise<{ sent: true } | { refused: SendRefusal | "identity-unenforceable" }>;
}

export function makeResponsibilityService(deps: ServiceDeps): ResponsibilityService {
	const { db, resps, wakes, pump } = deps;

	return {
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
					// Observation arms itself from the attachment rows; the
					// follow-up Program is step 4's link — until then the
					// responsibility is honestly not fully armed.
					resps.setArmed(
						responsibility.responsibilityId,
						false,
						"follow-up program not yet linked",
					);
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
			try {
				const outcome = await send(op.brief, att.target);
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
					return { refused: "already-terminal" };
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
}
