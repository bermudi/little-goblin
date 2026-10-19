import type { Desktops } from "../desktops.ts";
import { log } from "../log.ts";
import type { SubagentRun, SubagentRuns } from "../subagent-runs.ts";

export interface DrainDeps {
	runs: SubagentRuns;
	desktops: Desktops;
	maxRuns: number;
	lane: <T>(id: number, fn: () => Promise<T>) => Promise<T>;
	admit: (row: SubagentRun) => Promise<unknown>;
	retryAfter: Map<number, number>;
	halted: () => boolean;
	isResumed: () => boolean;
}

export interface Drain {
	scheduleDrain(): void;
	drain(): Promise<void>;
}

export function makeDrain(deps: DrainDeps): Drain {
	const { runs, desktops, maxRuns, lane, admit, retryAfter, halted, isResumed } = deps;

	const inflight = new Set<number>();

	function runningIds(): Set<number> {
		const ids = new Set<number>(inflight);
		for (const r of runs.unfinished()) {
			if (r.status === "running") ids.add(r.id);
		}
		return ids;
	}

	function eligible(row: SubagentRun, now: number): boolean {
		if (row.stopRequested) return false;
		if ((retryAfter.get(row.id) ?? 0) > now) return false;
		if (row.kind === "worker") {
			const lease = runs.workerLease(row.conversationId);
			if (lease !== null && lease.id !== row.id) return false;
			return true;
		}
		for (const other of runs.unfinished()) {
			if (
				other.id !== row.id &&
				other.kind === "computer" &&
				other.desktop === row.desktop &&
				(other.status === "running" || inflight.has(other.id))
			) {
				return false;
			}
		}
		const d = desktops.get(row.desktop!);
		if (d === null) return true;
		const held =
			d.leaseExpiresAt !== null &&
			d.leaseExpiresAt > now &&
			!(d.leaseKind === "run" && d.leaseId === String(row.id));
		return !held;
	}

	let draining = false;
	let wantDrain = false;

	async function drain(): Promise<void> {
		if (draining || halted()) {
			wantDrain = true;
			return;
		}
		draining = true;
		try {
			for (;;) {
				wantDrain = false;
				const free = maxRuns - runningIds().size;
				if (free <= 0) break;
				const now = Date.now();
				const candidates = runs
					.unfinished()
					.filter((r) => r.status === "queued" && !inflight.has(r.id) && eligible(r, now));
				const row = candidates[0];
				if (row === undefined) break;
				inflight.add(row.id);
				void lane(row.id, () => admit(row)).finally(() => {
					inflight.delete(row.id);
					scheduleDrain();
				});
			}
		} finally {
			draining = false;
		}
		if (wantDrain) scheduleDrain();
	}

	let drainScheduled = false;
	function scheduleDrain(): void {
		if (drainScheduled || halted() || !isResumed()) return;
		drainScheduled = true;
		queueMicrotask(() => {
			drainScheduled = false;
			void drain().catch((err) => log.error("subagent drain failed", err));
		});
	}

	return { scheduleDrain, drain };
}
