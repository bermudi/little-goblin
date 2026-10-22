// Channel-neutral mail approval owner. Queueing, expiry, in-flight
// exclusion, threading, Gmail send and the outbox CAS live here;
// transports only present the draft, render controls, report notices,
// and stamp their own UI.

import { domainOf, type MailPoller, type MailSender } from "./mail.ts";
import type { OutboxEntry, OutboxStore, QueueDraft } from "./mail-outbox.ts";
import { log } from "./log.ts";
import { telegramAddressOf, type ConversationTarget, type DecisionActor } from "./targets.ts";

const SWEEP_TICK_MS = 5 * 60_000;

export interface MailDraftInput {
	to: string[];
	cc?: string[];
	subject: string;
	body: string;
	replyToId?: string;
}

export type MailDraftAddress =
	| { target: ConversationTarget }
	| { chatId: number; threadId: number | null };

export type MailPresentationResult =
	| { kind: "posted"; messageId: number | null; surface: string }
	// Delivery may already exist; the row remains pending and actionable.
	| { kind: "uncertain"; detail: string }
	// Presentation definitely failed before controls existed; cancel the row.
	| { kind: "failed"; detail: string };

export interface MailApprovalLane {
	present(row: OutboxEntry): Promise<MailPresentationResult>;
	notice(row: OutboxEntry, text: string): Promise<void>;
	settle(row: OutboxEntry, text: string, opts?: { messageId?: number }): Promise<void>;
	strip(row: OutboxEntry, opts?: { messageId?: number }): Promise<void>;
}

/** A transport lane for a channel that was not booted. Presentation
 * fails explicitly; lifecycle calls stay no-ops so an existing durable
 * row remains readable and cancelable through another approval door. */
export function unavailableMailLane(reason: string): MailApprovalLane {
	return {
		present: async (row) => {
			log.warn("mail draft presentation unavailable", {
				outbox: row.id,
				target: row.target,
				reason,
			});
			return { kind: "failed", detail: reason };
		},
		notice: async (row, text) => {
			log.warn("mail notice skipped — channel disabled", {
				outbox: row.id,
				target: row.target,
				text: text.slice(0, 160),
				reason,
			});
		},
		settle: async (row) => {
			log.debug("mail draft stamp skipped — channel disabled", {
				outbox: row.id,
				target: row.target,
				reason,
			});
		},
		strip: async (row) => {
			log.debug("mail draft controls strip skipped — channel disabled", {
				outbox: row.id,
				target: row.target,
				reason,
			});
		},
	};
}

export interface MailApprovalDeps {
	outbox: OutboxStore;
	sender(): MailSender | null;
	reader(): MailPoller | null;
	lanes: {
		app: MailApprovalLane;
		telegram: MailApprovalLane;
	};
	now?(): Date;
}

export type MailDecision =
	| { kind: "gone" }
	| { kind: "settled"; row: OutboxEntry }
	| { kind: "busy"; row: OutboxEntry }
	| { kind: "expired"; row: OutboxEntry }
	| { kind: "cancelled"; row: OutboxEntry }
	| { kind: "sent"; row: OutboxEntry }
	| { kind: "retry"; row: OutboxEntry; message: string }
	| { kind: "conflict"; row: OutboxEntry };

export interface MailApproval {
	requestDraft(
		input: MailDraftInput,
		address: MailDraftAddress,
	): Promise<{ queued: number; status: string } | { error: string }>;
	decide(
		id: number,
		action: "send" | "cancel",
		actor: DecisionActor,
		opts?: { messageId?: number },
	): Promise<MailDecision>;
	pending(): OutboxEntry[];
	sweep(): Promise<void>;
	stop(): Promise<void>;
}

export function startMailApproval(deps: MailApprovalDeps, tickMs = SWEEP_TICK_MS): MailApproval {
	const inFlight = new Map<number, Promise<void>>();

	const laneFor = (row: OutboxEntry): MailApprovalLane =>
		telegramAddressOf(row.target) === null ? deps.lanes.app : deps.lanes.telegram;

	const requestDraft = async (
		input: MailDraftInput,
		address: MailDraftAddress,
	): Promise<{ queued: number; status: string } | { error: string }> => {
		const queued: QueueDraft = { ...input, address };
		const row = deps.outbox.queue(queued);
		let presented: MailPresentationResult;
		try {
			presented = await laneFor(row).present(row);
		} catch (err) {
			presented = {
				kind: "failed",
				detail: err instanceof Error ? err.message : String(err),
			};
		}
		if (presented.kind === "posted") {
			if (presented.messageId !== null) deps.outbox.bindDraft(row.id, presented.messageId);
			return {
				queued: row.id,
				status: `awaiting operator approval — the draft is in ${presented.surface}`,
			};
		}
		if (presented.kind === "uncertain") {
			return {
				queued: row.id,
				status: `draft #${row.id} delivery is uncertain — no automatic cancellation or retry; check the approval surface before retrying (${presented.detail})`,
			};
		}
		deps.outbox.decide(row.id, "cancelled", new Date());
		log.warn("mail draft presentation failed — draft cancelled", {
			outbox: row.id,
			target: row.target,
			error: presented.detail,
		});
		return {
			error: `posting draft #${row.id} failed — the draft was cancelled; retry when delivery recovers (${presented.detail})`,
		};
	};

	const decide = async (
		id: number,
		action: "send" | "cancel",
		actor: DecisionActor,
		opts?: { messageId?: number },
	): Promise<MailDecision> => {
		const row = deps.outbox.get(id);
		if (row === null) return { kind: "gone" };
		const lane = laneFor(row);
		const now = deps.now?.() ?? new Date();
		if (row.status !== "pending") {
			await lane.strip(row, opts);
			return { kind: "settled", row };
		}
		if (inFlight.has(id)) return { kind: "busy", row };
		if (now.getTime() >= new Date(row.expiresAt).getTime()) {
			if (!deps.outbox.decide(id, "expired", now)) {
				const fresh = deps.outbox.get(id);
				return fresh === null ? { kind: "gone" } : { kind: "settled", row: fresh };
			}
			const fresh = deps.outbox.get(id)!;
			await lane.settle(fresh, `⌛ Draft #${id} expired — never sent.`, opts);
			return { kind: "expired", row: fresh };
		}
		if (action === "cancel") {
			if (!deps.outbox.decide(id, "cancelled", now, undefined, actor)) {
				const fresh = deps.outbox.get(id);
				return fresh === null ? { kind: "gone" } : { kind: "settled", row: fresh };
			}
			const fresh = deps.outbox.get(id)!;
			await lane.settle(fresh, `🚫 Draft #${id} cancelled — never sent.`, opts);
			return { kind: "cancelled", row: fresh };
		}

		const send = (async (): Promise<MailDecision> => {
			try {
				return await sendApproved(deps, row, lane, now, actor, opts);
			} finally {
				inFlight.delete(id);
			}
		})();
		inFlight.set(
			id,
			send.then(() => undefined),
		);
		return send;
	};

	const sweep = async (): Promise<void> => {
		const now = deps.now?.() ?? new Date();
		let rows: OutboxEntry[];
		try {
			rows = deps.outbox.expireDue(now, (id) => inFlight.has(id));
		} catch (err) {
			log.error("outbox expiry sweep failed", err);
			return;
		}
		await Promise.allSettled(
			rows.map((row) => laneFor(row).settle(row, `⌛ Draft #${row.id} expired — never sent.`)),
		);
		if (rows.length > 0) log.info("outbox expiry swept", { count: rows.length });
	};

	const timer = setInterval(() => {
		void sweep();
	}, tickMs);
	void sweep();

	return {
		requestDraft,
		decide,
		pending: () => deps.outbox.pending(),
		sweep,
		stop: async () => {
			clearInterval(timer);
			const waits = [...inFlight.values()];
			if (waits.length > 0) {
				log.info("mail approval — joining in-flight send on shutdown", {
					sends: waits.length,
				});
			}
			await Promise.allSettled(waits);
		},
	};
}

async function sendApproved(
	deps: MailApprovalDeps,
	row: OutboxEntry,
	lane: MailApprovalLane,
	now: Date,
	actor: DecisionActor,
	opts?: { messageId?: number },
): Promise<MailDecision> {
	const sender = deps.sender();
	if (sender === null) {
		const message = "⚠️ mail is not configured — the draft stays queued.";
		await lane.notice(row, message);
		return { kind: "retry", row, message };
	}
	let threadId: string | undefined;
	let inReplyTo: string | null | undefined;
	if (row.replyToId !== null) {
		const reader = deps.reader();
		if (reader === null) {
			const message =
				"⚠️ mail reading is not configured — couldn't thread the reply — Send can retry.";
			await lane.notice(row, message);
			return { kind: "retry", row, message };
		}
		let ctx: { threadId: string; messageId: string | null } | null;
		try {
			ctx = await reader.threadFor(row.replyToId);
		} catch (err) {
			log.error("mail send threading lookup failed", err, { outbox: row.id });
			const message = `⚠️ couldn't reach Gmail to thread the reply (${err instanceof Error ? err.message : String(err)}) — Send can retry.`;
			await lane.notice(row, message);
			return { kind: "retry", row, message };
		}
		if (ctx === null) {
			const message =
				"⚠️ the message this answers is gone — cancel and re-queue without a reply, or edit the draft.";
			await lane.notice(row, message);
			return { kind: "retry", row, message };
		}
		threadId = ctx.threadId;
		inReplyTo = ctx.messageId;
	}
	let sent: { id: string; threadId: string };
	try {
		sent = await sender.send({
			to: row.to,
			...(row.cc.length > 0 ? { cc: row.cc } : {}),
			subject: row.subject,
			body: row.body,
			...(threadId !== undefined ? { threadId } : {}),
			...(inReplyTo !== undefined ? { inReplyTo } : {}),
		});
	} catch (err) {
		log.error("mail send failed — draft stays pending for a retry", err, {
			outbox: row.id,
			to: row.to.map(domainOf),
		});
		const message = `⚠️ send failed (${err instanceof Error ? err.message : String(err)}) — Send can retry.`;
		await lane.notice(row, message);
		return { kind: "retry", row, message };
	}
	if (!deps.outbox.decide(row.id, "sent", now, sent.id, actor)) {
		log.warn("mail sent but the row was already decided — possible duplicate", { outbox: row.id });
		const fresh = deps.outbox.get(row.id);
		return fresh === null ? { kind: "gone" } : { kind: "conflict", row: fresh };
	}
	const fresh = deps.outbox.get(row.id)!;
	await lane.settle(
		fresh,
		`✅ Draft #${row.id} sent to ${row.to.join(", ")} — "${row.subject || "(no subject)"}".`,
		opts,
	);
	return { kind: "sent", row: fresh };
}
