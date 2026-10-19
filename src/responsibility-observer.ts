// Deterministic observation — ordinary code, not model polling. One
// bounded snapshot per Herdr target per tick reconciles every live
// attachment: cursor, work event, and pending wake commit in ONE
// transaction, then the dispatcher pumps. Source keys are namespaced
// by attachment generation and durable reset epoch so reused sequences
// survive both reattachment and server resets. A repeated poll
// dedupes to nothing and spends no model call. An
// unreachable Herdr target is a skipped group — never evidence that
// its agents vanished. A same-pane replacement is a different
// attachment: agent_session changes mark identity_changed and the
// observer leaves the occupant alone until a deliberate reattach.

import type { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "./log.ts";
import { HerdrError, type OperatorAgent } from "./herdr.ts";
import type { Attachment, ResponsibilityStore } from "./responsibilities.ts";
import type { WakeStore } from "./wake-store.ts";

const observedCursorSchema = z.object({
	/** Last observed state_change_seq — the poll sequence key. */
	seq: z.number().int().nonnegative().nullable(),
	completionSeq: z.number().int().nonnegative().nullable(),
	status: z.string(),
	agentSession: z.string().nullable(),
	terminalId: z.string().nullable(),
	name: z.string().nullable(),
	missing: z.boolean(),
	/** Durable reset namespace; old cursors begin at epoch zero. */
	epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});
export type ObservedCursor = z.infer<typeof observedCursorSchema>;

export interface ObserverDeps {
	db: Database;
	resps: ResponsibilityStore;
	wakes: WakeStore;
	/** The dispatcher's pump — run after the cursor/event transaction
	 *  commits so a crash never sees a cursor ahead of its wake. */
	pump(): void;
	/** One snapshot per (server, session) group — the adapter seam. */
	list(server: string, session: string): Promise<OperatorAgent[]>;
}

export interface ResponsibilityObserver {
	/** One bounded pass over every open responsibility's attachments. */
	observe(): Promise<void>;
}

// Match by the stable identity the attachment recorded at bind:
// terminal_id when the server reports it, else the pane — absence of
// identity fields is explicit (policy input), not a pane+kind guess.
function matchOf(att: Attachment, agents: OperatorAgent[]): OperatorAgent | null {
	if (att.target.terminalId !== null) {
		return agents.find((a) => a.terminal_id === att.target.terminalId) ?? null;
	}
	return agents.find((a) => a.pane_id === att.target.paneId) ?? null;
}

function cursorFrom(a: OperatorAgent | null, prev: ObservedCursor | null): ObservedCursor {
	if (a === null) {
		return {
			epoch: prev?.epoch ?? 0,
			seq: prev?.seq ?? null,
			completionSeq: prev?.completionSeq ?? null,
			status: "missing",
			agentSession: prev?.agentSession ?? null,
			terminalId: prev?.terminalId ?? null,
			name: prev?.name ?? null,
			missing: true,
		};
	}
	return {
		epoch: prev?.epoch ?? 0,
		seq: a.state_change_seq,
		completionSeq: a.completion_seq,
		status: a.agent_status,
		agentSession: a.agent_session,
		terminalId: a.terminal_id,
		name: a.name ?? null,
		missing: false,
	};
}

const SIGHTED: ReadonlySet<string> = new Set(["attached", "missing"]);
const WATCHED: ReadonlySet<string> = new Set(["active", "waiting_for_operator", "blocked"]);

export function makeResponsibilityObserver(deps: ObserverDeps): ResponsibilityObserver {
	const { db, resps, wakes, pump, list } = deps;

	// One transaction: new cursor + optional health transition + unique
	// work event + pending wake link (wakes.record joins the
	// conversation's pending wake itself). Health rides the commit —
	// a crash between them must not leave a cursor that already
	// forgives a replacement while health still says 'attached'.
	function commit(
		att: Attachment,
		conversationId: string,
		cursor: ObservedCursor,
		health: "attached" | "missing" | "identity_changed" | null,
		dev: { sourceKey: string; kind: string; text: string; facts: unknown } | null,
	): void {
		// Joins reconcile's transaction, including its lifecycle checks.
		resps.updateCursor(att.attachmentId, cursor);
		if (health !== null) resps.setHealth(att.attachmentId, health);
		if (dev !== null) {
			wakes.record({
				sourceKey: dev.sourceKey,
				conversationId,
				kind: dev.kind,
				text: dev.text,
				facts: dev.facts,
				origin: "observer",
				responsibilityId: att.responsibilityId,
			});
		}
	}

	function reconcile(snapshot: Attachment, agents: OperatorAgent[]): void {
		db.transaction(() => {
			// list awaited external work. Re-read authority AND cursor in
			// the same transaction as every write: detach/reattach, pause
			// and closure must win over that older observation.
			const att = resps.getAttachment(snapshot.attachmentId);
			const resp = resps.get(snapshot.responsibilityId);
			if (
				att === null ||
				att.generation !== snapshot.generation ||
				!SIGHTED.has(att.health) ||
				resp === null ||
				!WATCHED.has(resp.status)
			) {
				log.info("responsibility observation superseded", {
					attachment: snapshot.attachmentId,
					observedGeneration: snapshot.generation,
					generation: att?.generation,
					health: att?.health,
					responsibility: snapshot.responsibilityId,
					status: resp?.status,
				});
				return;
			}
			reconcileCurrent(att, resp.coordinationConversationId, agents);
		})();
	}

	function reconcileCurrent(
		att: Attachment,
		conversationId: string,
		agents: OperatorAgent[],
	): void {
		const g = att.generation;
		const prev = att.cursor === null ? null : observedCursorSchema.parse(att.cursor);
		let epoch = prev?.epoch ?? 0;
		const key = (kind: string, seq: string | number) =>
			`obs:${att.attachmentId}:g${g}:e${epoch}:${kind}:${seq}`;
		const found = matchOf(att, agents);

		if (found === null) {
			if (prev?.missing !== true) {
				commit(att, conversationId, cursorFrom(null, prev), "missing", {
					sourceKey: key("missing", prev?.seq ?? "na"),
					kind: "agent-missing",
					text: `attached agent ${att.target.agentName} is no longer listed`,
					facts: { attachmentId: att.attachmentId, generation: g },
				});
			} else {
				commit(att, conversationId, cursorFrom(null, prev), null, null);
			}
			return;
		}

		const cur = cursorFrom(found, prev);
		const reset = prev !== null && prev.seq !== null && cur.seq !== null && cur.seq < prev.seq;
		if (reset) {
			epoch += 1;
			if (!Number.isSafeInteger(epoch))
				throw new Error(`attachment ${att.attachmentId}: cursor epoch exhausted`);
			cur.epoch = epoch;
		}
		// Identity first: the same terminal/pane hosting a different
		// harness session is a replacement — mark it and stop watching.
		if (
			att.target.agentSession !== null &&
			cur.agentSession !== null &&
			cur.agentSession !== att.target.agentSession
		) {
			commit(att, conversationId, cur, "identity_changed", {
				sourceKey: key("identity", cur.agentSession),
				kind: "identity-changed",
				text: `attached agent ${att.target.agentName} was replaced (new harness session)`,
				facts: {
					attachmentId: att.attachmentId,
					generation: g,
					from: att.target.agentSession,
					to: cur.agentSession,
				},
			});
			return;
		}
		// Recovered availability after a disappearance.
		if (prev?.missing === true) {
			commit(att, conversationId, cur, "attached", {
				sourceKey: key("recovered", cur.seq ?? "na"),
				kind: "agent-recovered",
				text: `attached agent ${att.target.agentName} is listed again (${cur.status})`,
				facts: { attachmentId: att.attachmentId, generation: g, status: cur.status },
			});
			return;
		}
		// Cursor regression — baseline only for this poll. The persisted
		// epoch makes a later reused completion number fresh, not a
		// collision with a development from before the reset.
		if (reset) {
			commit(att, conversationId, cur, null, {
				sourceKey: key("cursor-reset", cur.seq ?? "na"),
				kind: "cursor-reset",
				text: `observation sequence for ${att.target.agentName} regressed (${prev.seq} → ${cur.seq})`,
				facts: { attachmentId: att.attachmentId, generation: g, from: prev.seq, to: cur.seq },
			});
			return;
		}
		// A completion tick the cursor hasn't seen.
		if (
			cur.completionSeq !== null &&
			(prev === null || prev.completionSeq === null || cur.completionSeq > prev.completionSeq)
		) {
			commit(att, conversationId, cur, null, {
				sourceKey: key("done", cur.completionSeq),
				kind: "done-candidate",
				text: `attached agent ${att.target.agentName} reported completion #${cur.completionSeq}`,
				facts: {
					attachmentId: att.attachmentId,
					generation: g,
					completionSeq: cur.completionSeq,
					status: cur.status,
				},
			});
			return;
		}
		// Blocked/input-needed is a development only on transition.
		if (cur.status === "blocked" && prev?.status !== "blocked") {
			commit(att, conversationId, cur, null, {
				sourceKey: key("blocked", cur.seq ?? "na"),
				kind: "blocked-candidate",
				text: `attached agent ${att.target.agentName} looks blocked`,
				facts: { attachmentId: att.attachmentId, generation: g, status: cur.status },
			});
			return;
		}
		// Stable work: cursor only, no event, no model spend.
		commit(att, conversationId, cur, null, null);
	}

	let inflight: Promise<void> | null = null;

	return {
		observe() {
			// One pass at a time — a slow target must not stack ticks.
			if (inflight !== null) return inflight;
			inflight = observeOnce().finally(() => {
				inflight = null;
			});
			return inflight;
		},
	};

	async function observeOnce(): Promise<void> {
		// Group live attachments per Herdr target — one list call serves
		// every attachment on that server/session.
		{
			const groups = new Map<string, { server: string; session: string; atts: Attachment[] }>();
			for (const resp of resps.open()) {
				if (!WATCHED.has(resp.status)) continue;
				for (const att of resps.attachmentsFor(resp.responsibilityId)) {
					if (!SIGHTED.has(att.health)) continue;
					const k = `${att.target.server}${att.target.session}`;
					const group = groups.get(k) ?? {
						server: att.target.server,
						session: att.target.session,
						atts: [],
					};
					group.atts.push(att);
					groups.set(k, group);
				}
			}
			for (const group of groups.values()) {
				let agents: OperatorAgent[];
				try {
					agents = await list(group.server, group.session);
				} catch (err) {
					// Only a CLI/target failure is an unavailable snapshot.
					// Malformed output and unexpected errors propagate; they
					// must not masquerade as normal target unavailability.
					if (!(err instanceof HerdrError)) throw err;
					log.warn("responsibility observation unreachable", {
						server: group.server,
						session: group.session,
						attachments: group.atts.map((a) => a.attachmentId),
						error: err.message,
					});
					continue;
				}
				for (const att of group.atts) reconcile(att, agents);
			}
			// After every transaction has committed — never inside one.
			pump();
		}
	}
}
