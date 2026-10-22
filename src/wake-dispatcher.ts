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
// recovers turns; it never fails one. The one durable exception is the
// wake's bookkeeping, never the turn: a wake whose ownership link
// cannot be persisted, or whose attempt died before any run began,
// fails closed (failUnlinked), because reconcile reads an unlinked
// claim as never-admitted and would resubmit a trigger that already
// ran — and while even that terminal write refuses, a process-local
// fence holds resubmission and each pump retries the closure.

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

	// Wakes whose ownership write failed this process, wake → reason.
	// While a wake sits here its submit is fenced: reconcile reads an
	// unlinked claim as never-admitted and would resubmit a trigger the
	// live (or finished) run already processed. The durable closure —
	// failUnlinked — retries on every pump; until it lands, the process
	// -local fence is what keeps the resubmission from ever firing.
	const unlinked = new Map<number, string>();

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
		if (unlinked.has(rec.wakeId)) {
			log.warn("wake submit fenced — ownership link never persisted", {
				wake: rec.wakeId,
				conversation: rec.conversationId,
			});
			return;
		}
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

	// The durable fail-closed write plus its process-local fence, shared
	// by every path that must terminally close an unlinked claim — a lost
	// ownership link and a pre-run terminal failure alike. While the
	// write refuses (or the claim somehow stays open), the wake sits in
	// `unlinked`: every pump retries the closure instead of resubmitting.
	function closeUnlinked(wakeId: number, reason: string): void {
		try {
			if (wakes.failUnlinked(wakeId, reason)) {
				unlinked.delete(wakeId);
				return;
			}
			const current = wakes.get(wakeId);
			if (current !== null && current.state === "claimed" && current.runId === null) {
				// Still an open unlinked claim — the write path refuses.
				unlinked.set(wakeId, reason);
			} else {
				// Linked or terminal meanwhile — nothing left to fence.
				unlinked.delete(wakeId);
			}
		} catch (err) {
			unlinked.set(wakeId, reason);
			log.error("wake fail-closed write failed — submit fenced for this process", err, {
				wake: wakeId,
			});
		}
	}

	// The run owns its wake only once the link is durable — but the hook
	// cannot gate the turn, so a failed link fails the WAKE closed: the
	// terminal write fences reconcile's resubmission, and this process
	// -local map fences the submit path for as long as even that write
	// refuses. The run itself proceeds untouched either way.
	function linkMessages(runId: string, messageIds: string[]): void {
		for (const w of wakes.claimedForMessages(messageIds)) {
			try {
				wakes.linkRun(w.wakeId, runId);
				// A prior attempt's fence lifts only when the link lands.
				unlinked.delete(w.wakeId);
			} catch (err) {
				log.error("wake ownership link failed — failing the wake closed", err, {
					wake: w.wakeId,
					run: runId,
					conversation: w.conversationId,
				});
				closeUnlinked(
					w.wakeId,
					`ownership link to run ${runId} failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
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
				unlinked.delete(rec.wakeId);
				guard("settle", () => wakes.settle(rec.wakeId, "settled"));
			}
			for (const rec of plan.toFail) {
				unlinked.delete(rec.wakeId);
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
				const reason = unlinked.get(rec.wakeId);
				if (reason !== undefined) {
					// Retry the durable closure each pass; until the store
					// accepts it, the fence — not a resubmission — answers for
					// this wake. A thrown write leaves the fence untouched, so
					// the next pass retries instead of submitting.
					guard("failUnlinked", () => {
						if (wakes.failUnlinked(rec.wakeId, reason)) {
							unlinked.delete(rec.wakeId);
							return;
						}
						const current = wakes.get(rec.wakeId);
						if (current !== null && current.state === "claimed" && current.runId === null) {
							log.warn("wake ownership closure still failing — submit stays fenced", {
								wake: rec.wakeId,
								conversation: rec.conversationId,
							});
						} else {
							// Linked or terminal meanwhile — the fence is stale.
							unlinked.delete(rec.wakeId);
						}
					});
					continue;
				}
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
			preRunFailure(e) {
				// A terminal failure before the run row began — admission,
				// makeTools, the model view, a journal write — never links
				// its members, so reconcile would read the claimed wake as
				// unowned and re-admit the trigger every pump. The same
				// fail-closed write as a lost ownership link applies: the
				// trigger is durable history, its disposition is terminal,
				// and a refusing store fences the wake rather than letting
				// the next pump submit it again.
				guard("pre-run failure", () => {
					for (const w of wakes.claimedForMessages(e.memberMessageIds)) {
						if (w.runId !== null) continue; // linked — reconcile owns it
						closeUnlinked(
							w.wakeId,
							`turn failed before its run started: ${e.error}`,
						);
					}
				});
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
