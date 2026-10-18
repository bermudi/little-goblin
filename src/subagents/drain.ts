// Queue admission — the global run-slot scheduler (design/subagents.md
// → Owner decomposition ruling 2026-10-17). Extracted from mod.ts
// verbatim: slots are the union of rows actually executing and rows
// mid-flight, needs_input frees its slot, and every caller that frees
// capacity kicks scheduleDrain — the drain then admits eligible queued
// rows through the run lane. Owns the in-flight set and the scan
// coalescing flags; retryAfter stays admission's map, shared here
// only for eligibility reads.

import type { Desktops } from "../desktops.ts";
import { log } from "../log.ts";
import type { SubagentRun, SubagentRuns } from "../subagent-runs.ts";

export interface DrainDeps {
	runs: SubagentRuns;
	desktops: Desktops;
	maxRuns: number;
	lane: <T>(id: number, fn: () => Promise<T>) => Promise<T>;
	// The drain ignores the outcome — the row's own state carries it.
	admit: (row: SubagentRun) => Promise<unknown>;
	// Admission's retry-backoff map, shared for eligibility reads.
	retryAfter: Map<number, number>;
	/** closing || harnessClosed — the owner resolves the pair. */
	halted: () => boolean;
	/** Gate on resume(): nothing drains before the owner resumes. */
	isResumed: () => boolean;
}

export interface Drain {
	scheduleDrain(): void;
	drain(): Promise<void>;
}

export function makeDrain(deps: DrainDeps): Drain {
	const { runs, desktops, maxRuns, lane, admit, retryAfter, halted, isResumed } = deps;

	// Rows mid-flight (admitting or aborting) — the drain adds the id
	// before the lane runs admit and removes it after, so a queued row
	// is never double-admitted across coalesced drains.
	const inflight = new Set<number>();

	// Slots = the union of rows actually executing and rows mid-flight
	// (admitting or aborting) — never double-counted, never a slot for
	// needs_input or a queued row.
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
			// The lease's holder may be this very row (a resume) — a
			// queued second worker on the same sandbox never jumps ahead
			// because the lease query ranks active/resuming rows first.
			if (lease !== null && lease.id !== row.id) return false;
			return true;
		}
		// computer: the desktop's live holder and sibling runs decide.
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
		if (d === null) return true; // admission fails once, loudly
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
