// Notices land before watcher transitions; every write is CAS against
// the scanned row so an in-flight send wins. `starting` rows are boot
// recovery: they transition in finally even if their notice fails.
// T3 Code has no completion push — this poll is the drift-checked
// `thread show` contract (design/agents.md → delegate).

import { log } from "./log.ts";
import type { Delegation } from "./delegations.ts";
import { t3CutShort, t3Waiting, t3Working } from "./t3.ts";
import { READINESS_OBSERVE_MS, readinessKey, type GithubIssue } from "./pr-readiness.ts";
import type { DelegationLifecycle, DelegationLifecycleDeps } from "./delegation-lifecycle.ts";
import { launch, OUTSIDE_STOP_NOTE, read, send, stop, stopByOperator } from "./delegation-actions.ts";
import { notify, observeReadiness } from "./delegation-notices.ts";
import { isIssueLead } from "./delegation-paths.ts";

const TICK_MS = 15_000;
// Symmetric backstop for a `working` thread that never progresses: the
// show record's updatedAt is the only activity signal, so a long
// healthy task is indistinguishable from a frozen one before the 2 h
// openclaw precedent (#489).
const PROGRESS_STALL_MS = 2 * 3_600_000;

const activeWatchers = new WeakSet<object>();

export function startDelegationLifecycle(
	deps: DelegationLifecycleDeps,
	tickMs = TICK_MS,
): DelegationLifecycle {
	if (activeWatchers.has(deps.delegations))
		throw new Error("startDelegationLifecycle already active for this store");
	activeWatchers.add(deps.delegations);
	let stopped = false;
	let stopping: Promise<void> | null = null;
	// Share the in-flight scan so timer ticks never overlap and awaiters observe completion.
	let current: Promise<void> | null = null;
	// Stop joins these before the store closes: an op running past close
	// strands its row in its pre-op state, which boot recovery misreads —
	// a live thread's row would still say `starting`.
	const inFlight = new Set<Promise<unknown>>();
	const tracked = <T>(p: Promise<T>): Promise<T> => {
		inFlight.add(p);
		// Rejections still reach their awaiter; this tap only detaches the
		// promise from the join set.
		void p
			.finally(() => {
				inFlight.delete(p);
			})
			.catch(() => {});
		return p;
	};
	// `starting` rows are owned by an in-flight launch; only the first scan
	// can instead interpret one as a launch interrupted by process death.
	let firstScan = true;
	// Watcher memory only: each running row's last observed updatedAt and
	// when it last moved. No column — a restart re-seeds from the row
	// itself.
	const lastProgress = new Map<number, { updatedAt: string; sinceMs: number }>();
	const scan = (): Promise<void> => {
		if (current !== null) return current;
		if (stopped) return Promise.resolve();
		// Assign the finally wrapper, not the work promise: synchronous work can finish
		// before the assignment lands and otherwise permanently wedge subsequent scans.
		const work = (async () => {
			if (firstScan) {
				firstScan = false;
				for (const d of deps.delegations.starting()) {
					try {
						await recoverStart(deps, d);
					} catch (err) {
						log.error("delegation start recovery failed", err, {
							delegation: d.id,
							name: d.name,
						});
					}
				}
			}
			const active = deps.delegations.active();
			for (const d of active) {
				// Isolate row failures while logging them; one bad row must not stop the scan
				// or hide the other delegations' verdicts.
				try {
					await check(deps, d, lastProgress);
				} catch (err) {
					log.error("delegation check failed", err, {
						delegation: d.id,
						name: d.name,
					});
				}
				// The stall clock only runs on `running` — any leave (this
				// scan's verdict or a tool-side write) retires the entry.
				if (d.status !== "running") lastProgress.delete(d.id);
			}
			const watched = new Set(active.map((d) => d.id));
			for (const id of lastProgress.keys()) {
				if (!watched.has(id)) lastProgress.delete(id);
			}
			for (const d of deps.delegations.list()) {
				if (d.status !== "done" || !isIssueLead(d)) continue;
				try {
					await checkReadiness(deps, d);
				} catch (err) {
					log.error("delegation readiness check failed", err, { delegation: d.id });
				}
			}
		})();
		current = work.finally(() => {
			current = null;
		});
		return current;
	};
	const timer = setInterval(() => {
		void scan();
	}, tickMs);
	void scan();
	return {
		launch: (input) => tracked(launch(deps, input)),
		send: (id, text) => tracked(send(deps, id, text)),
		stop: (id) => tracked(stop(deps, id)),
		stopByOperator: (id) => tracked(stopByOperator(deps, id)),
		read: (id, messages) => tracked(read(deps, id, messages)),
		list: () => deps.delegations.list(),
		tick: scan,
		stopTicker: () => {
			if (stopping !== null) return stopping;
			stopped = true;
			clearInterval(timer);
			// Join the scan and in-flight ops before releasing ownership:
			// shutdown closes the store next, so an op holding launch/send
			// progress must land its row transition (or fail loud) first.
			stopping = (async () => {
				await (current ?? Promise.resolve());
				while (inFlight.size > 0) {
					await Promise.allSettled([...inFlight]);
				}
			})().finally(() => {
				activeWatchers.delete(deps.delegations);
			});
			return stopping;
		},
	};
}

async function checkReadiness(
	deps: DelegationLifecycleDeps,
	d: Delegation & { issue: GithubIssue; responsibilityId: string },
): Promise<void> {
	if (deps.watchResponsibility?.(d.responsibilityId, d.responsibilityRevision) === false) return;
	// A failed delivery remains due even across restart, without another GitHub request.
	if (d.readiness !== null && d.readinessNotifiedKey !== readinessKey(d.readiness)) {
		await notify(deps, d, "done", { readiness: d.readiness });
		return;
	}
	if (d.readiness?.result.kind === "no-pr" && d.readiness.result.issueClosed) return;
	if (
		d.readiness !== null &&
		Date.now() - Date.parse(d.readiness.observedAt) < READINESS_OBSERVE_MS
	)
		return;
	const readiness = await observeReadiness(deps, d.issue);
	// Corrections, pause/cancel, send and stop may land during the remote read.
	if (deps.watchResponsibility?.(d.responsibilityId, d.responsibilityRevision) === false) return;
	if (!deps.delegations.recordReadiness(d.id, d, readiness)) {
		log.info("delegation readiness superseded", { delegation: d.id });
		return;
	}
	if (d.readinessNotifiedKey === readinessKey(readiness)) return;
	log.info("delegation readiness changed", { delegation: d.id, key: readinessKey(readiness) });
	await notify(deps, d, "done", { readiness });
}

// Watcher writes CAS against the scanned row; a concurrent send wins and
// is never overwritten. A successful transition updates the local snapshot for
// same-scan fall-through.
function transition(
	deps: DelegationLifecycleDeps,
	d: Delegation,
	to: Delegation["status"],
): boolean {
	const applied = deps.delegations.transitionIf(
		d.id,
		{ status: d.status, promptedAt: d.promptedAt },
		to,
	);
	if (!applied) {
		log.info("delegation transition superseded", {
			delegation: d.id,
			name: d.name,
			from: d.status,
			to,
		});
		return false;
	}
	log.info("delegation transition", {
		delegation: d.id,
		name: d.name,
		from: d.status,
		to,
	});
	d.status = to;
	return true;
}

// A starting row has no later scan to retry its notice — attempt the
// notice, transition in finally (a concurrent stop CAS wins). The T3
// thread, when one was bound before the death, keeps running: the
// notice names it so the operator can take over in T3 Code.
async function recoverStart(deps: DelegationLifecycleDeps, d: Delegation): Promise<void> {
	try {
		await notify(deps, d, "failed", {
			extra: "(goblin restarted while starting it)",
			body:
				d.t3Thread === null
					? "(no T3 thread was bound yet — nothing started)"
					: `(the T3 thread ${d.t3Thread} may have started without goblin watching; take over there or let it finish)`,
		});
	} finally {
		transition(deps, d, "failed");
	}
}

async function check(
	deps: DelegationLifecycleDeps,
	d: Delegation,
	lastProgress: Map<number, { updatedAt: string; sinceMs: number }>,
): Promise<void> {
	// Pre-t3 leftover (no thread bound): the store's open sweep already
	// settles these; if one slipped through, say it once and stop watching.
	if (d.t3Thread === null) {
		const landed = await notify(deps, d, "failed", {
			extra: "(a pre-T3 delegation the current transport cannot observe)",
			body: "(this row predates the T3 Code transport; its old agent, if any, is unobserved)",
		});
		if (landed) transition(deps, d, "failed");
		return;
	}
	let shown;
	try {
		shown = await deps.t3.showThread(d.t3Thread, 1);
	} catch (err) {
		// Cannot observe is not thread gone — the server may be down while
		// the thread runs, so leave the row watched rather than settling.
		log.error("delegation check unreachable", err, {
			delegation: d.id,
			name: d.name,
			thread: d.t3Thread,
		});
		return;
	}
	if (shown === null) {
		// The thread vanished from T3 Code — deleted or gone with a server
		// reset. An outside stop: the operator decides what
		// happens next, and goblin never revives it unasked.
		const landed = await notify(deps, d, "stopped", {
			extra: OUTSIDE_STOP_NOTE,
			body: "(the T3 thread no longer exists)",
		});
		if (landed) transition(deps, d, "stopped");
		return;
	}
	const t = shown.thread;
	const status = t.status;

	// A cut-short run (interrupted/cancelled/rolled_back) is someone's
	// explicit stop — the outside-stop verdict.
	if (t3CutShort(status)) {
		const landed = await notify(deps, d, "stopped", {
			extra: OUTSIDE_STOP_NOTE,
			body: `(the thread's last run ended "${status}")`,
		});
		if (landed) transition(deps, d, "stopped");
		return;
	}

	if (t3Waiting(status)) {
		// The run waits for an answer (the --wait exit-2 condition). The
		// operator answers in T3 Code or goblin relays with action 'send'.
		if (d.status === "needs_input") return;
		const landed = await notify(deps, d, "needs input", {
			extra:
				"(the harness is waiting for an answer — relay the operator's reply with action 'send', or they can answer in T3 Code)",
		});
		if (landed) transition(deps, d, "needs_input");
		return;
	}

	if (status === "completed" || status === "idle" || status === "failed") {
		// A queued message (pendingRequestCount) may still owe our run:
		// only a clear latest-run attribution settles the row.
		const oursIsLatest = t.latestRunId === d.t3Run;
		const pending = (t.pendingRequestCount ?? 0) > 0;
		if (!oursIsLatest && pending) return;
		if (status === "failed") {
			const landed = await notify(deps, d, "failed");
			if (landed) transition(deps, d, "failed");
			return;
		}
		// Our run's reply may have scrolled out of the message window when
		// the thread moved on — the notice still lands with the thread link.
		const movedOn = !oursIsLatest && t.latestRunId !== null && t.latestRunId !== undefined;
		const landed = await notify(deps, d, "done", {
			...(movedOn
				? {
						extra:
							"(the thread has later activity beyond goblin's run — the excerpt may be from a newer turn; read the thread)",
					}
				: {}),
		});
		if (landed) transition(deps, d, "done");
		return;
	}

	if (t3Working(status)) {
		const now = Date.now();
		// The run is in flight. A needs_input row that works again was
		// answered (in T3 or by our own send) — back to running, with the
		// stall clock restarted: the answer proves liveness, and the row's
		// promptedAt only refreshes when goblin itself sent.
		if (d.status === "needs_input" && transition(deps, d, "running")) {
			lastProgress.set(d.id, { updatedAt: t.updatedAt, sinceMs: now });
		}
		// A working thread that never progresses gets one notice after 2 h:
		// updatedAt is the only activity signal (#489).
		let progress = lastProgress.get(d.id);
		if (progress === undefined || progress.updatedAt !== t.updatedAt) {
			progress = {
				updatedAt: t.updatedAt,
				sinceMs:
					progress === undefined ? Date.parse(d.promptedAt) : now,
			};
			lastProgress.set(d.id, progress);
		}
		const stalledMs = now - progress.sinceMs;
		if (stalledMs > PROGRESS_STALL_MS) {
			const landed = await notify(deps, d, "needs input", {
				extra: `(no thread activity for ${Math.floor(stalledMs / 3_600_000)} h — the run may be frozen; check it in T3 Code)`,
			});
			if (landed) {
				log.info("delegation progress stall", {
					delegation: d.id,
					name: d.name,
					updatedAt: t.updatedAt,
					stalledMs,
				});
				transition(deps, d, "needs_input");
			}
		}
		return;
	}

	// An unrecognized status: never guess a verdict. Loud, and the row
	// stays watched for the next scan (or a human).
	log.error("delegation check saw unknown thread status", undefined, {
		delegation: d.id,
		name: d.name,
		thread: d.t3Thread,
		status,
	});
}
