import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Submission } from "@earendil-works/pi-durable";
import { openSubagentRuns, type SubagentRun, type SubagentRuns } from "../subagent-runs.ts";
import type { Admission, AdmitOutcome } from "./admission.ts";
import type { ApprovalGate } from "./approval-gate.ts";
import { SubagentError } from "./errors.ts";
import { makeRecovery, type RecoveryDeps } from "./recovery.ts";
import { makeRowAccess } from "./row-access.ts";
import type { RunOutcomeBody } from "./run-doc.ts";

const dirs: string[] = [];
const stores: SubagentRuns[] = [];
afterEach(() => {
	for (const s of stores) s.close();
	stores.length = 0;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

function rig(
	opts: {
		conv?: { abort?: () => Promise<void> } | null;
		outcome?: (RunOutcomeBody & { rev: number }) | null;
		submission?: unknown;
		admit?: (row: SubagentRun, preserve?: boolean) => Promise<AdmitOutcome>;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-rec-"));
	dirs.push(dir);
	const runs = openSubagentRuns(join(dir, "runs.sqlite"));
	stores.push(runs);
	const flags = { closing: false, harnessClosed: false };
	const calls = {
		monitored: [] as { rowId: number; rev: number }[],
		finalized: [] as { rowId: number; rev: number }[],
		readmits: [] as { row: SubagentRun; outcome: AdmitOutcome }[],
		notified: 0,
		released: 0,
		drains: 0,
		aborts: 0,
	};
	const conv = {
		abort: async () => {
			calls.aborts += 1;
			await opts.conv?.abort?.();
		},
		waitForIdle: async () => {},
	};
	const harness = {
		conversation: async () => (opts.conv === null ? undefined : (opts.conv ?? conv)),
		snapshot: async () => ({ runId: 1, inputRev: 1, outcome: opts.outcome ?? null }),
		submission: async () =>
			opts.submission === undefined
				? ({ id: 55 } as unknown as Submission)
				: (opts.submission ?? undefined),
		resume: () => {},
	};
	const access = makeRowAccess({
		runs,
		isClosing: () => flags.closing,
		isHarnessClosed: () => flags.harnessClosed,
	});
	const admission = {
		admit: async (row: SubagentRun, preserve?: boolean) =>
			(opts.admit?.(row, preserve) ?? { kind: "admitted" }) as AdmitOutcome,
		readmitOutcome: (row: SubagentRun, outcome: AdmitOutcome) => {
			calls.readmits.push({ row, outcome });
		},
	} satisfies Admission;
	const lanes = new Map<number, Promise<unknown>>();
	const lane = <T>(id: number, fn: () => Promise<T>): Promise<T> => {
		const next = (lanes.get(id) ?? Promise.resolve()).then(fn);
		lanes.set(
			id,
			next.catch(() => {}),
		);
		return next;
	};
	const deps: RecoveryDeps = {
		runs,
		lane,
		harness: harness as unknown as RecoveryDeps["harness"],
		access,
		admission,
		monitor: (rowId, rev) => {
			calls.monitored.push({ rowId, rev });
		},
		finalize: async (rowId, rev) => {
			calls.finalized.push({ rowId, rev });
		},
		gate: {
			withGate: <T>(t: T): T => t,
			approvalKey: () => "k",
			takeWaiter: () => undefined,
			storeDecision: () => {},
			dropForConversation: () => {},
		} satisfies ApprovalGate,
		releaseLeases: () => {
			calls.released += 1;
		},
		notify: () => {
			calls.notified += 1;
		},
		scheduleDrain: () => {
			calls.drains += 1;
		},
		recoveryPending: new Set(),
		recoveryAttempts: new Map(),
		isClosing: () => flags.closing,
		isHarnessClosed: () => flags.harnessClosed,
	};
	const recovery = makeRecovery(deps);
	const mkrow = (patch: Partial<Parameters<SubagentRuns["update"]>[1]> = {}) =>
		runs.update(
			runs.create({
				kind: "worker",
				conversationId: "dm:1",
				workspace: "/w",
				task: "t",
			}).id,
			{ status: "running", piConversationId: "7", inputRev: 1, ...patch },
		);
	return { runs, recovery, mkrow, calls, deps, flags };
}

describe("nudge", () => {
	test("a live row at the claimed rev takes the nudge intent and goes recovery-pending", async () => {
		const { runs, recovery, mkrow, deps } = rig();
		const row = mkrow();
		await recovery.nudge(row.id, 1, BACKGROUND_CONTEXT);
		const after = runs.get(row.id);
		expect(after?.inputRev).toBe(2);
		expect(after?.inputIntent).toMatch(/previous model request aborted/);
		expect(deps.recoveryPending.has(row.id)).toBe(true);
	});

	test("a stale rev stamps no intent but the row still goes recovery-pending", async () => {
		const { runs, recovery, mkrow, deps } = rig();
		const row = mkrow({ inputRev: 3 });
		await recovery.nudge(row.id, 1, BACKGROUND_CONTEXT);
		expect(runs.get(row.id)?.inputIntent).toBeNull();
		expect(deps.recoveryPending.has(row.id)).toBe(true);
	});

	test("a stopped or non-running row is untouched", async () => {
		const { runs, recovery, mkrow } = rig();
		const row = mkrow({ stopRequested: true });
		await recovery.nudge(row.id, 1, BACKGROUND_CONTEXT);
		expect(runs.get(row.id)?.inputIntent).toBeNull();
	});
});

describe("recoverRun", () => {
	test("a missing Pi conversation settles the row failed — the lookup IS the death proof", async () => {
		const { runs, recovery, mkrow } = rig({ conv: null });
		const row = mkrow();
		await recovery.recoverRun(row);
		const after = runs.get(row.id);
		expect(after?.status).toBe("failed");
		expect(after?.error).toBe("Pi conversation missing after restart");
	});

	test("a committed outcome at the live rev finalizes instead of re-admitting", async () => {
		const { recovery, mkrow, calls } = rig({
			outcome: { kind: "done", result: "landed before the crash", files: [], rev: 1 },
		});
		const row = mkrow({ inputRev: 1 });
		await recovery.recoverRun(row);
		expect(calls.finalized).toEqual([{ rowId: row.id, rev: 1 }]);
		expect(calls.readmits).toHaveLength(0);
	});

	test("a reacquirable submission reattaches its monitor — the live work keeps its watcher", async () => {
		const { recovery, mkrow, calls } = rig({ outcome: null });
		const row = mkrow({ piSubmissionId: "55" });
		await recovery.recoverRun(row);
		expect(calls.monitored).toEqual([{ rowId: row.id, rev: 1 }]);
		expect(calls.readmits).toHaveLength(0);
	});

	test("a persisted input intent re-admits through the preserve-running path", async () => {
		const { recovery, mkrow, calls } = rig({ outcome: null });
		const row = mkrow({ inputIntent: "the operator's answer" });
		await recovery.recoverRun(row);
		expect(calls.readmits).toHaveLength(1);
		expect(calls.readmits[0]?.row.id).toBe(row.id);
		expect(calls.readmits[0]?.outcome).toEqual({ kind: "admitted" });
	});

	test("no conversation and no intent settles failed; an intent requeues", async () => {
		const { runs, recovery, mkrow } = rig();
		const dead = mkrow({ piConversationId: null });
		await recovery.recoverRun(dead);
		expect(runs.get(dead.id)?.status).toBe("failed");
		expect(runs.get(dead.id)?.error).toBe("no Pi conversation recorded");
		const pending = mkrow({ piConversationId: null, inputIntent: "unconsumed" });
		await recovery.recoverRun(pending);
		expect(runs.get(pending.id)?.status).toBe("queued");
	});
});

describe("recoverParked", () => {
	test("a parked row reacquires its submission's monitor — the watcher must attach before the gate re-enters", async () => {
		const { recovery, mkrow, calls } = rig();
		const row = mkrow({
			status: "needs_input",
			piSubmissionId: "55",
			pendingApproval: { piTaskId: "t", callId: "c", tool: "bash", args: {}, attempts: 1 },
		});
		await recovery.recoverParked(row.id);
		expect(calls.monitored).toEqual([{ rowId: row.id, rev: 1 }]);
	});

	test("a park without a reacquirable submission is a loud corrupt-park failure", async () => {
		const { recovery, mkrow } = rig({ submission: null });
		const row = mkrow({
			status: "needs_input",
			piSubmissionId: "55",
			pendingApproval: { piTaskId: "t", callId: "c", tool: "bash", args: {}, attempts: 1 },
		});
		await expect(recovery.recoverParked(row.id)).rejects.toThrow(SubagentError);
	});
});

describe("drive", () => {
	test("one pass spends one bounded attempt on each pending row", async () => {
		const { recovery, mkrow, deps } = rig({ outcome: null });
		const row = mkrow({ piSubmissionId: "55" });
		deps.recoveryPending.add(row.id);
		await recovery.drive();
		expect(deps.recoveryAttempts.get(row.id)?.count).toBe(1);
		expect(deps.recoveryAttempts.has(row.id)).toBe(true);
	});

	test("a row that left running settles out of the retry bookkeeping", async () => {
		const { runs, recovery, mkrow, deps } = rig();
		const row = mkrow({ status: "done" });
		deps.recoveryPending.add(row.id);
		deps.recoveryAttempts.set(row.id, { count: 4, lastError: "old" });
		await recovery.drive();
		expect(deps.recoveryAttempts.has(row.id)).toBe(false);
		expect(runs.get(row.id)?.status).toBe("done");
	});

	test("past the attempt bound, a confirmed cancel settles failed", async () => {
		const { runs, recovery, mkrow, deps, calls } = rig();
		const row = mkrow();
		deps.recoveryPending.add(row.id);
		deps.recoveryAttempts.set(row.id, { count: 10, lastError: "keeps failing" });
		await recovery.drive();
		const after = runs.get(row.id);
		expect(after?.status).toBe("failed");
		expect(after?.error).toMatch(/recovery failed after 11 attempts/);
		expect(calls.aborts).toBe(1);
		expect(calls.notified).toBe(1);
		expect(deps.recoveryAttempts.has(row.id)).toBe(false);
	});

	test("past the bound, an unconfirmed cancel keeps the row owned and pending", async () => {
		const { runs, recovery, mkrow, deps } = rig({
			conv: {
				abort: async () => {
					throw new Error("cancel could not be confirmed");
				},
			},
		});
		const row = mkrow();
		deps.recoveryPending.add(row.id);
		deps.recoveryAttempts.set(row.id, { count: 10, lastError: "keeps failing" });
		await recovery.drive();
		expect(runs.get(row.id)?.status).toBe("running");
		expect(deps.recoveryPending.has(row.id)).toBe(true);
	});
});
