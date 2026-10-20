// Wake dispatch — executes the wake store's durable delivery plan
// through the Runtime. Deliver is commit (the stable trigger lands in
// history exactly once) plus submitPersisted (admit-only, never
// re-append). Ownership is the journal run's: the runtime's
// runOwnership hooks link a claimed wake to the run that takes its
// trigger message — initial claims, resume queue claims, mid-run
// steer joins — or retarget it off a run the attempt continues
// (explicit resume) or inherits (overflow). Settlement reads the
// journal's terminal stamp, never a submit/onDone callback: a lost
// callback or a dead process leaves the truth intact for reconcile.
// Every hook and pump is internally total — this module observes and
// recovers turns; it never fails one.

import type { UIMessage } from "ai";
import type { Conversation, ConversationStore } from "./conversation.ts";
import { log } from "./log.ts";
import type { Runtime, RuntimeDeps, TurnSink } from "./runtime.ts";
import type { JournalStatus, TurnJournal } from "./turn-journal.ts";
import type { DevelopmentInput, ReconcilePlan, WakeRecord, WakeStore } from "./wake-store.ts";

export interface WakeDispatcherDeps {
	store: ConversationStore;
	wakes: WakeStore;
	journal: TurnJournal;
	runtime: Runtime;
	// The wake turn's delivery sink — the composition's bell/delivery
	// routing by channel, same as every headless submit.
	sinkFor(conv: Conversation): TurnSink;
	// Pre-execution submit failures retry under bounded exponential
	// backoff; the defaults are production-sized, tests inject smaller.
	backoff?: { baseMs: number; capMs: number };
	now?(): number;
}

export interface WakeDispatcher {
	/** Record a development durably, then pump delivery. A duplicate
	 *  source key still pumps — its wake may owe action. */
	record(input: DevelopmentInput): { eventId: number; wakeId: number; created: boolean };
	/** Record a sweep's developments before pumping once — the batch is
	 *  what lets the store coalesce them into the conversation's one
	 *  pending wake. Per-record pumping commits the first instantly and
	 *  the rest would land as separate wakes. */
	recordAll(inputs: DevelopmentInput[]): { eventId: number; wakeId: number; created: boolean }[];
	/** One classify-and-act pass over every open wake. Boot, the
	 *  ticker, and the run-end hook all run the same pass. */
	pump(): void;
	/** The runtime's runOwnership hooks — total by construction. */
	hooks: NonNullable<RuntimeDeps["runOwnership"]>;
	/** The persistent-retry ticker — the only mover for wakes gated on
	 *  a backoff clock. Returns the stopper. */
	startTicker(intervalMs?: number): () => void;
}

const DEFAULT_BACKOFF = { baseMs: 5_000, capMs: 300_000 };
const TICKER_MS = 15_000;

export function makeWakeDispatcher(deps: WakeDispatcherDeps): WakeDispatcher {
	const { store, wakes, journal, runtime } = deps;
	const backoff = { ...DEFAULT_BACKOFF, ...(deps.backoff ?? {}) };
	const now = () => deps.now?.() ?? Date.now();
	const nowIso = () => new Date(now()).toISOString();

	// The journal answer reconcile() needs — following the resume chain
	// to the live end: a 'resumed' row consumed its wake forward to the
	// newest successor admitted from it. Settlement reads the chain's
	// end, so a wake stranded on a consumed source still resolves; a
	// cycle or a missing link is the corruption it reports.
	function runStatus(runId: string): JournalStatus | null {
		const seen = new Set<string>();
		let cur: string | null = runId;
		while (cur !== null && !seen.has(cur)) {
			seen.add(cur);
			const run = journal.get(cur);
			if (run === null) return null;
			// Overflow withholds delivery while the same admitted messages
			// move to a successor. Its failed attempt is terminal, but its
			// wake is not. Admission (and the epoch) bounds this hold: stop,
			// failed continuation admission, or process death ends it.
			if (
				run.status === "error" &&
				run.delivery === "undelivered" &&
				store.get(run.conversationId)?.epoch === run.epoch &&
				wakes.forRun(cur).some((w) => runtime.isAdmitted(w.conversationId, w.messageId))
			)
				return "running";
			if (run.status !== "resumed") return run.status;
			const next = journal.successorOf(cur);
			if (next === null) return "error"; // resumed with no successor — corrupt
			cur = next;
		}
		return null;
	}

	// The live end of the wake's resume chain — null when the link row
	// itself is gone (reconcile already classified that wake failed;
	// a null here only declines the retarget).
	function chainEnd(runId: string): string | null {
		const seen = new Set<string>();
		let cur: string | null = runId;
		let last = runId;
		while (cur !== null && !seen.has(cur)) {
			seen.add(cur);
			const run = journal.get(cur);
			if (run === null) return null;
			last = cur;
			if (run.status !== "resumed") return cur;
			cur = journal.successorOf(cur);
		}
		return cur === null ? last : null;
	}

	// Internally total: one wake's bad row or one thrown write must not
	// take down the pass or the turn the hook rode in on.
	function guard(what: string, fn: () => void): void {
		try {
			fn();
		} catch (err) {
			log.error(`wake dispatch ${what} failed`, err);
		}
	}

	// The durable reason a classified wake fails — admission authority
	// lost, the run's terminal state, or a link the journal can't
	// resolve at all (missing row, resume-chain cycle). A pending wake
	// in toFail is the orphaned-conversation classification: its
	// trigger was never appended anywhere.
	function failReason(rec: WakeRecord): string {
		if (rec.state === "pending") return "wake conversation row is missing";
		if (rec.runId === null) return "wake admission authority expired or is unknown";
		const status = runStatus(rec.runId);
		return status === null
			? `turn run ${rec.runId} is missing or its resume chain is corrupt`
			: `turn run ${rec.runId} ended ${status}`;
	}

	function triggerOf(rec: WakeRecord): UIMessage {
		return { id: rec.messageId, role: "user", parts: [{ type: "text", text: rec.text }] };
	}

	// The submit half — claimed wakes only: the trigger is already
	// durable history, so admission is submitPersisted, never submit.
	function submit(rec: WakeRecord): void {
		const conv = store.get(rec.conversationId);
		if (conv === null) {
			// The FK keeps conversations with wakes alive, so this is data
			// surgery — loud every pass, never silently dropped.
			log.error("wake conversation missing — cannot deliver", undefined, {
				wake: rec.wakeId,
				conversation: rec.conversationId,
			});
			return;
		}
		if (!runtime.accepting()) return; // shutdown — the next boot owns it
		if (runtime.isAdmitted(conv.id, rec.messageId)) {
			log.debug("wake submit skipped — already admitted", {
				wake: rec.wakeId,
				conversation: rec.conversationId,
			});
			return;
		}
		const admitted = runtime.submitPersisted(conv, triggerOf(rec), deps.sinkFor(conv));
		if (!admitted) {
			log.warn("wake submit refused — runtime closed", {
				wake: rec.wakeId,
				conversation: rec.conversationId,
			});
		}
	}

	function submitGuarded(rec: WakeRecord): void {
		try {
			submit(rec);
		} catch (err) {
			// A pre-execution failure retries under bounded backoff; the
			// wake keeps its claim — the trigger stays exactly-once.
			const next = new Date(
				now() + Math.min(backoff.capMs, backoff.baseMs * 2 ** rec.attempts),
			).toISOString();
			guard("noteFailure", () =>
				wakes.noteFailure(rec.wakeId, err instanceof Error ? err.message : String(err), next),
			);
		}
	}

	function deliver(rec: WakeRecord): void {
		const conv = store.get(rec.conversationId);
		if (conv === null) {
			log.error("wake conversation missing — cannot append trigger", undefined, {
				wake: rec.wakeId,
				conversation: rec.conversationId,
			});
			return;
		}
		const claimed = wakes.commit(rec.wakeId, ({ id, text }) =>
			store.append(conv.id, [{ id, role: "user", parts: [{ type: "text", text }] }]),
		);
		submitGuarded(claimed);
	}

	function linkMessages(runId: string, messageIds: string[]): void {
		for (const w of wakes.claimedForMessages(messageIds)) {
			guard("link", () => wakes.linkRun(w.wakeId, runId));
		}
	}

	const dispatcher: WakeDispatcher = {
		record(input) {
			const out = wakes.record(input);
			dispatcher.pump();
			return out;
		},

		recordAll(inputs) {
			const out = inputs.map((i) => wakes.record(i));
			dispatcher.pump();
			return out;
		},

		pump() {
			let plan: ReconcilePlan;
			try {
				plan = wakes.reconcile(nowIso(), runStatus);
			} catch (err) {
				log.error("wake reconcile failed", err);
				return;
			}
			for (const rec of plan.toSettle) {
				guard("settle", () => wakes.settle(rec.wakeId, "settled"));
			}
			for (const rec of plan.toFail) {
				// Pending orphans can't take the settle path (it requires a
				// real claim); failOrphan is their terminal transition.
				guard("fail", () =>
					rec.state === "pending"
						? wakes.failOrphan(rec.wakeId, failReason(rec))
						: wakes.settle(rec.wakeId, "failed", { error: failReason(rec) }),
				);
			}
			// Keep run_id at the live end of its resume chain: forRun and
			// the begin hook's retarget stay meaningful for the next
			// resume admission.
			for (const rec of plan.preserved) {
				guard("retarget", () => {
					if (rec.runId === null) return;
					const end = chainEnd(rec.runId);
					if (end !== null && end !== rec.runId) wakes.retargetRun(rec.wakeId, rec.runId, end);
				});
			}
			for (const rec of plan.toAppend) {
				guard("deliver", () => deliver(rec));
			}
			for (const rec of plan.toResubmit) {
				submitGuarded(rec);
			}
		},

		hooks: {
			begin(e) {
				guard("run begin", () => {
					for (const from of [e.resumedFrom, ...(e.inheritFrom ?? [])]) {
						if (from === undefined) continue;
						for (const w of wakes.forRun(from)) {
							if (w.state !== "claimed") continue;
							guard("retarget", () => wakes.retargetRun(w.wakeId, from, e.runId));
						}
					}
					linkMessages(e.runId, e.memberMessageIds);
				});
			},
			members(runId, messageIds) {
				guard("run members", () => linkMessages(runId, messageIds));
			},
			end(runId, status, delivery) {
				guard("run end", () => {
					log.debug("wake run ended", { run: runId, status, delivery });
					dispatcher.pump();
				});
			},
		},

		startTicker(intervalMs = TICKER_MS) {
			const t = setInterval(() => guard("ticker", () => dispatcher.pump()), intervalMs);
			t.unref();
			return () => clearInterval(t);
		},
	};
	return dispatcher;
}
