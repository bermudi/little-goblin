// Notices land before watcher transitions; every write is CAS against the
// scanned row so an in-flight send/stop wins. `starting` rows are boot
// recovery: they transition in finally even if their notice fails.

import { statSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";
import type { Delegation, DelegationStatus } from "./delegations.ts";
import type { AgentInfo } from "./herdr.ts";
import { readinessKey, type GithubIssue } from "./pr-readiness.ts";
import type { DelegationLifecycle, DelegationLifecycleDeps } from "./delegation-lifecycle.ts";
import {
	answer,
	launch,
	OUTSIDE_STOP_NOTE,
	read,
	send,
	stop,
	stopByOperator,
} from "./delegation-actions.ts";
import { notify, observeReadiness } from "./delegation-notices.ts";
import {
	closeWorkspaceQuietly,
	herdrFor,
	isIssueLead,
	machineRootFor,
	reportNote,
	reportPathFor,
} from "./delegation-paths.ts";

const TICK_MS = 15_000;
// A fresh prompt can report idle before working; give the harness time to advance
// its seq before calling it stuck on a startup dialog.
const STALL_MS = 90_000;
// Symmetric backstop for a `working` report that never progresses: openclaw
// finalizes stale subagent runs after 2 h, and herdr exposes no
// output-activity signal, so a long healthy task is indistinguishable from a
// frozen one before that (#489).
const PROGRESS_STALL_MS = 2 * 3_600_000;
// A report mtime can lag Date.now(); headroom prevents a same-tick report
// from being mistaken for the previous run.
const REPORT_SKEW_MS = 200;

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
	// a live agent's row would still say `starting`.
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
	// Watcher memory only: each running row's last observed seq and when it
	// last moved. No column — a restart re-seeds from the row itself.
	const lastProgress = new Map<number, { seq: number; sinceMs: number }>();
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
		answer: (id, key) => tracked(answer(deps, id, key)),
		stop: (id) => tracked(stop(deps, id)),
		stopByOperator: (id) => tracked(stopByOperator(deps, id)),
		read: (id, lines) => tracked(read(deps, id, lines)),
		reportPath: (id) => {
			const d = deps.delegations.get(id);
			return d === null
				? join(deps.delegationsDir, String(id), "report.md")
				: reportPathFor(deps, d);
		},
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
	if (d.readiness !== null && Date.now() - Date.parse(d.readiness.observedAt) < 60_000) return;
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

// Watcher writes CAS against the scanned row; a concurrent send/stop wins and
// is never overwritten. A successful transition updates the local snapshot for
// same-scan fall-through.
function transition(
	deps: DelegationLifecycleDeps,
	d: Delegation,
	to: DelegationStatus,
	baseline?: number,
): boolean {
	const applied = deps.delegations.transitionIf(
		d.id,
		{ status: d.status, promptedAt: d.promptedAt },
		to,
		baseline,
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

// A starting row has no later scan to retry its notice — close the workspace,
// attempt the notice, transition in finally (a concurrent stop CAS wins). This
// deliberately differs from notice-before-transition: waiting on the notice
// would leave the row invisible to every later scan.
async function recoverStart(deps: DelegationLifecycleDeps, d: Delegation): Promise<void> {
	if (d.workspaceId) {
		await closeWorkspaceQuietly(deps, d.id, d.workspaceId, d.target);
	}
	try {
		await notify(deps, d, "failed", {
			extra: "(goblin restarted while starting it)",
			agentGone: d.agentName === "",
		});
	} finally {
		transition(deps, d, "failed");
	}
}

// Deliver an owed prompt after the dialog advances seq. A rejected prompt
// re-baselines for retry rather than spamming every tick. A stop after
// delivery can win the state CAS but cannot retract the sent prompt.
async function deliverPendingPrompt(
	deps: DelegationLifecycleDeps,
	d: Delegation,
	info: AgentInfo,
): Promise<void> {
	const promptedAt = new Date();
	try {
		await herdrFor(deps, d.target).prompt(d.agentName, d.task + reportNote(deps, d));
	} catch (err) {
		log.warn("delegation pending prompt rejected", err, {
			delegation: d.id,
			name: d.name,
		});
		transition(deps, d, "needs_input", info.state_change_seq);
		return;
	}
	// Never use the pre-prompt seq; a failed read leaves the next scan to capture
	// instead of making the park's first idle glance a false completion.
	let seq: number | null = null;
	try {
		seq = (await herdrFor(deps, d.target).get(d.agentName))?.state_change_seq ?? null;
	} catch (err) {
		log.warn("delegation post-prompt baseline read failed — watcher will capture", err, {
			delegation: d.id,
		});
	}
	if (deps.delegations.markRunning(d.id, seq, promptedAt) === null) {
		log.info("delegation stopped while delivering pending prompt", {
			delegation: d.id,
			name: d.name,
		});
		return;
	}
	log.info("delegation task delivered after dialog", {
		delegation: d.id,
		name: d.name,
	});
}

// Freshness is attributed by the local report's mtime — send archives the old
// report first so a previous run cannot complete the new one. Machine rows have
// no local report and rely on seq.
function freshReportFor(deps: DelegationLifecycleDeps, d: Delegation): boolean {
	if (machineRootFor(deps, d.target) !== null) return false;
	try {
		// Filesystem clocks can lag Date.now() — headroom keeps a report written
		// during the prompt fresh.
		return statSync(reportPathFor(deps, d)).mtimeMs >= Date.parse(d.promptedAt) - REPORT_SKEW_MS;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		return false;
	}
}

async function check(
	deps: DelegationLifecycleDeps,
	d: Delegation,
	lastProgress: Map<number, { seq: number; sinceMs: number }>,
): Promise<void> {
	let info: AgentInfo | null;
	try {
		info = await herdrFor(deps, d.target).get(d.agentName);
	} catch (err) {
		// Cannot observe is not agent gone — an unreachable machine may still
		// be running, so leave its row watched rather than marking failed.
		log.error("delegation check unreachable", err, {
			delegation: d.id,
			name: d.name,
			target: d.target ?? "local",
		});
		return;
	}
	if (info === null) {
		// Goblin never ends its own agents without marking the row first, so a
		// vanished agent was stopped from outside (#414). A crash looks the
		// same; either way the operator decides what happens next.
		// A gone agent may leave useful exit text in the surviving pane, so the fallback
		// read still accompanies the failed notice.
		const landed = await notify(deps, d, "stopped", {
			extra: OUTSIDE_STOP_NOTE,
			agentGone: true,
		});
		if (landed) transition(deps, d, "stopped");
		return;
	}

	if (d.baselineSeq === null) {
		// Pending baseline: never compare against a pre-prompt seq — capture the
		// seq under the same CAS as other writes and let the next scan judge it.
		// A completion already folded into the captured seq can never advance
		// past itself: settle it now from a fresh report, or park when
		// attribution is unknown.
		const capture = (): boolean => {
			if (
				deps.delegations.captureBaseline(
					d.id,
					{ status: d.status, promptedAt: d.promptedAt },
					info.state_change_seq,
				)
			) {
				d.baselineSeq = info.state_change_seq;
				log.info("delegation baseline captured", {
					delegation: d.id,
					name: d.name,
					seq: info.state_change_seq,
				});
				return true;
			}
			log.info("delegation baseline capture superseded", {
				delegation: d.id,
				name: d.name,
			});
			return false;
		};
		if (d.status === "needs_input" && d.promptPending && info.agent_status !== "blocked") {
			// Capture must win before attempting the owed prompt; a later stop can still race delivery.
			if (capture()) await deliverPendingPrompt(deps, d, info);
			return;
		}
		// A done/completion_seq folded into the capture cannot beat its baseline:
		// a fresh report attributes it to this run, otherwise park at
		// needs_input. Notify before capture so a failed notice leaves the
		// pending posture and retries, instead of stranding a finished agent
		// behind its baseline; the screen tail carries the truth.
		const finished =
			info.agent_status === "done" ||
			(info.agent_status === "idle" && info.completion_seq !== undefined);
		if (finished) {
			if (freshReportFor(deps, d)) {
				const landed = await notify(deps, d, "done");
				if (landed && capture()) transition(deps, d, "done");
			} else {
				const landed = await notify(deps, d, "needs input", {
					extra:
						"(finished before the baseline was captured — this completion can't be attributed to the prompted run; check the result, then follow up or stop)",
				});
				if (landed && capture()) transition(deps, d, "needs_input", info.state_change_seq);
			}
			return;
		}
		capture();
		return;
	}

	if (d.status === "needs_input") {
		// Seq advance, not a transient status, detects work done through an
		// attached session — an operator can finish between polls without ever
		// showing working.
		if (info.state_change_seq <= d.baselineSeq) return;
		// A cleared startup dialog owes the task prompt. Re-baseline a rejected
		// prompt so navigation does not resend every tick; only this path sends
		// owed prompts.
		if (d.promptPending) {
			await deliverPendingPrompt(deps, d, info);
			return;
		}
		// Apply running rules in this tick; a failed CAS means a tool write won.
		if (!transition(deps, d, "running")) return;
	}

	if (info.agent_status === "blocked") {
		const landed = await notify(deps, d, "needs input");
		// The re-baseline on a block is part of the same CAS; only post-block seq changes
		// can resume the row.
		if (landed) transition(deps, d, "needs_input", info.state_change_seq);
		return;
	}
	if (info.agent_status === "idle" || info.agent_status === "done") {
		// A fresh local report can complete work folded into the baseline; old
		// reports are archived on send so reuse never reads stale output.
		// Machine rows use seq — their remote report cannot be checked here.
		const freshReport = freshReportFor(deps, d);
		// completion_seq marks completed work (catching finishes between polls);
		// servers without it fall back to the state_change_seq comparison. A
		// startup idle with neither signal stays in flight until the stall rule.
		const doneSeq = info.completion_seq ?? info.state_change_seq;
		if (doneSeq > d.baselineSeq || freshReport) {
			const landed = await notify(deps, d, "done");
			if (landed) transition(deps, d, "done");
			return;
		}
		if (info.agent_status === "idle" && Date.now() - Date.parse(d.promptedAt) > STALL_MS) {
			const landed = await notify(deps, d, "needs input", {
				extra: "(agent never started working — likely stuck on a startup dialog)",
			});
			if (landed) transition(deps, d, "needs_input", info.state_change_seq);
		}
		return;
	}

	// Still running past every verdict. A frozen worker reports `working`
	// forever — seq stagnation is the only observable (#489).
	const now = Date.now();
	let progress = lastProgress.get(d.id);
	if (progress === undefined || progress.seq !== info.state_change_seq) {
		progress = {
			seq: info.state_change_seq,
			// A seq still at the baseline provably never moved since the
			// prompt; anything else moved at an unknown time — count from now.
			sinceMs:
				progress === undefined && info.state_change_seq === d.baselineSeq
					? Date.parse(d.promptedAt)
					: now,
		};
		lastProgress.set(d.id, progress);
	}
	const stalledMs = now - progress.sinceMs;
	if (
		(info.agent_status === "working" || info.agent_status === "unknown") &&
		stalledMs > PROGRESS_STALL_MS
	) {
		const landed = await notify(deps, d, "needs input", {
			extra: `(no status change for ${Math.floor(stalledMs / 3_600_000)} h — the agent may be frozen; check its pane)`,
		});
		if (landed) {
			log.info("delegation progress stall", {
				delegation: d.id,
				name: d.name,
				seq: info.state_change_seq,
				stalledMs,
			});
			transition(deps, d, "needs_input", info.state_change_seq);
		}
	}
}
