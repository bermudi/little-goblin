// drain.ts boundary tests — the scheduler's eligibility and
// coalescing invariants (design/subagents.md → Owner decomposition;
// Scheduling). Real run store (unfinished()/workerLease() are real
// queries); desktops is a stub lease table; admit is a spy. Pinned:
// nothing drains before resume, the global slot cap counts running +
// inflight, eligibility refuses stopped/backed-off/lease-blocked
// rows, and a drain requested mid-flight re-runs after the lane
// frees.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Desktops } from "../desktops.ts";
import { openSubagentRuns, type SubagentRun, type SubagentRuns } from "../subagent-runs.ts";
import { makeDrain } from "./drain.ts";

const dirs: string[] = [];
const stores: SubagentRuns[] = [];
afterEach(() => {
	for (const s of stores) s.close();
	stores.length = 0;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

type DesktopStub = {
	leaseKind: "run" | "conversation" | "operator" | null;
	leaseId: string | null;
	leaseExpiresAt: number | null;
};

function rig(
	opts: {
		maxRuns?: number;
		desktop?: DesktopStub | null;
		admit?: (row: SubagentRun) => Promise<unknown>;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-drn-"));
	dirs.push(dir);
	const runs = openSubagentRuns(join(dir, "runs.sqlite"));
	stores.push(runs);
	const flags = { halted: false, resumed: true };
	const retryAfter = new Map<number, number>();
	const admitted: number[] = [];
	// A real serial lane — promise-chained per row id, like the owner's.
	const lanes = new Map<number, Promise<unknown>>();
	const lane = <T>(id: number, fn: () => Promise<T>): Promise<T> => {
		const next = (lanes.get(id) ?? Promise.resolve()).then(fn);
		lanes.set(
			id,
			next.catch(() => {}),
		);
		return next;
	};
	const drain = makeDrain({
		runs,
		desktops: {
			get: () => (opts.desktop === undefined ? null : opts.desktop),
		} as unknown as Desktops,
		maxRuns: opts.maxRuns ?? 2,
		lane,
		admit: async (row) => {
			admitted.push(row.id);
			await opts.admit?.(row);
			// An admitted row runs — leaving it queued would re-admit
			// it on the drain the finally schedules, forever.
			runs.update(row.id, { status: "running" });
		},
		retryAfter,
		halted: () => flags.halted,
		isResumed: () => flags.resumed,
	});
	let convSeq = 0;
	const mkrow = (
		patch: Partial<Parameters<SubagentRuns["update"]>[1]> = {},
		kind = "worker",
		conversationId?: string,
	) =>
		runs.update(
			runs.create({
				kind: kind as SubagentRun["kind"],
				// Distinct conversations by default — the worker lease
				// tests share one explicitly.
				conversationId: conversationId ?? `dm:${++convSeq}`,
				workspace: "/w",
				task: "t",
				desktop: kind === "computer" ? "d0" : null,
			}).id,
			{ status: "queued", ...patch },
		);
	return { runs, drain, mkrow, admitted, retryAfter, flags };
}

// scheduleDrain runs the drain on a microtask — flush it.
const flush = () => Bun.sleep(30);

describe("the resume and halt gates", () => {
	test("scheduleDrain is a no-op before resume() and while halted", async () => {
		const { drain, mkrow, admitted, flags } = rig();
		mkrow();
		flags.resumed = false;
		drain.scheduleDrain();
		await flush();
		expect(admitted).toHaveLength(0);
		flags.resumed = true;
		flags.halted = true;
		drain.scheduleDrain();
		await flush();
		expect(admitted).toHaveLength(0);
	});
});

describe("eligibility", () => {
	test("queued rows admit up to the slot cap; the excess waits for a free slot", async () => {
		const { drain, mkrow, admitted } = rig({ maxRuns: 2 });
		const a = mkrow();
		const b = mkrow();
		const c = mkrow();
		void a;
		drain.scheduleDrain();
		await flush();
		expect(admitted).toEqual([a.id, b.id]);
		expect(c.id).not.toBe(admitted[2]);
	});

	test("stopRequested and backed-off rows are skipped", async () => {
		const { drain, mkrow, admitted, retryAfter } = rig();
		const stopped = mkrow({ stopRequested: true });
		const backedOff = mkrow();
		retryAfter.set(backedOff.id, Date.now() + 60_000);
		const ok = mkrow();
		drain.scheduleDrain();
		await flush();
		expect(admitted).toEqual([ok.id]);
		expect(admitted).not.toContain(stopped.id);
		expect(admitted).not.toContain(backedOff.id);
	});

	test("a second queued worker on the same sandbox waits for the lease holder", async () => {
		const { runs, drain, mkrow, admitted } = rig({ maxRuns: 5 });
		const holder = mkrow({ status: "running" }, "worker", "dm:1");
		const queued = mkrow({}, "worker", "dm:1");
		expect(runs.workerLease("dm:1")?.id).toBe(holder.id);
		drain.scheduleDrain();
		await flush();
		expect(admitted).not.toContain(queued.id);
	});

	test("a computer run waits while a sibling runs on its desktop", async () => {
		const { drain, mkrow, admitted } = rig({ maxRuns: 5 });
		mkrow({ status: "running" }, "computer");
		const queued = mkrow({}, "computer");
		drain.scheduleDrain();
		await flush();
		expect(admitted).not.toContain(queued.id);
	});

	test("a computer run waits on an externally held desktop lease", async () => {
		const { drain, mkrow, admitted } = rig({
			maxRuns: 5,
			desktop: {
				leaseKind: "operator",
				leaseId: null,
				leaseExpiresAt: Date.now() + 60_000,
			},
		});
		const queued = mkrow({}, "computer");
		drain.scheduleDrain();
		await flush();
		expect(admitted).not.toContain(queued.id);
	});
});

describe("coalescing", () => {
	test("a drain requested mid-flight re-runs when the lane frees", async () => {
		// admit blocks on a manual gate — two rows go in-flight to the
		// slot cap, a third waits for a free slot, and the admit
		// finally's deferred drain picks it up when the lane frees.
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const { runs, drain, mkrow, admitted } = rig({
			maxRuns: 2,
			admit: () => gate,
		});
		const first = mkrow();
		const second = mkrow();
		const third = mkrow();
		drain.scheduleDrain();
		await flush();
		// Both slots are mid-flight — the third row has nowhere to go.
		expect(admitted).toEqual([first.id, second.id]);
		release();
		await flush();
		// Both admitted rows now hold their slots running — still full.
		expect(admitted).toEqual([first.id, second.id]);
		// A run settling frees its slot; the deferred drain admits the
		// waiting row into it.
		runs.update(first.id, { status: "done", finishedAt: Date.now() });
		drain.scheduleDrain();
		await flush();
		expect(admitted).toEqual([first.id, second.id, third.id]);
	});
});
