import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Submission } from "@earendil-works/pi-durable";
import type { Desktops } from "../desktops.ts";
import { openSubagentRuns, type SubagentRun, type SubagentRuns } from "../subagent-runs.ts";
import type { ApprovalGate } from "./approval-gate.ts";
import { makeRowAccess } from "./row-access.ts";
import type { RunOutcomeBody } from "./run-doc.ts";
import { makeSettle, type SettleDeps } from "./settle.ts";

const dirs: string[] = [];
const stores: SubagentRuns[] = [];
afterEach(() => {
	for (const s of stores) s.close();
	stores.length = 0;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

function rig(
	opts: { outcome?: (RunOutcomeBody & { rev: number }) | null; stopReason?: string | null } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-stl-"));
	dirs.push(dir);
	const runs = openSubagentRuns(join(dir, "runs.sqlite"));
	stores.push(runs);
	const flags = { closing: false, harnessClosed: false };
	const calls = {
		woke: [] as { conv: string; message: string }[],
		released: [] as string[],
		aborted: 0,
		dropped: [] as string[],
		drains: 0,
		exported: [] as string[][],
	};
	const conv = {
		abort: async () => {
			calls.aborted += 1;
		},
		waitForIdle: async () => {},
		entries: async () => ({
			items:
				opts.stopReason === undefined
					? []
					: [{ model: [{ role: "assistant", stopReason: opts.stopReason }] }],
		}),
	};
	const harness = {
		snapshot: async () => ({ runId: 1, inputRev: 1, outcome: opts.outcome ?? null }),
		conversation: async () => conv,
	};
	const access = makeRowAccess({
		runs,
		isClosing: () => flags.closing,
		isHarnessClosed: () => flags.harnessClosed,
	});
	const gate = {
		withGate: <T>(t: T): T => t,
		approvalKey: () => "k",
		takeWaiter: () => undefined,
		storeDecision: () => {},
		dropForConversation: (pi: string) => {
			calls.dropped.push(pi);
		},
	} satisfies ApprovalGate;
	const lanes = new Map<number, Promise<unknown>>();
	const lane = <T>(id: number, fn: () => Promise<T>): Promise<T> => {
		const next = (lanes.get(id) ?? Promise.resolve()).then(fn);
		lanes.set(
			id,
			next.catch(() => {}),
		);
		return next;
	};
	const deps: SettleDeps = {
		runs,
		lane,
		harness: harness as unknown as SettleDeps["harness"],
		access,
		desktops: {
			release: async (d: string) => {
				calls.released.push(d);
			},
			get: () => null,
		} as unknown as Desktops,
		exportOutcomeFiles: (async (_row: SubagentRun, files: string[]) => {
			calls.exported.push(files);
			return { exported: files, errors: [] };
		}) as unknown as SettleDeps["exportOutcomeFiles"],
		wake: (conv, message) => {
			calls.woke.push({ conv, message });
			return true;
		},
		gate,
		scheduleDrain: () => {
			calls.drains += 1;
		},
		admitAttempts: new Map(),
		retryAfter: new Map(),
		recoveryPending: new Set(),
		recoveryAttempts: new Map(),
		isClosing: () => flags.closing,
		isHarnessClosed: () => flags.harnessClosed,
	};
	const settle = makeSettle(deps);
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
	return { runs, settle, mkrow, calls, flags, deps };
}

describe("finalize — the outcome matrix", () => {
	test("a done outcome marks the row done, exports its files, and wakes the origin", async () => {
		const { runs, settle, mkrow, calls } = rig({
			outcome: { kind: "done", result: "all set", files: ["out.txt"], rev: 1 },
		});
		const row = mkrow();
		await settle.finalize(row.id, 1);
		const after = runs.get(row.id);
		expect(after?.status).toBe("done");
		expect(after?.result).toBe("all set");
		expect(after?.exportedFiles).toEqual(["out.txt"]);
		expect(calls.exported).toEqual([["out.txt"]]);
		expect(calls.woke).toHaveLength(1);
		expect(calls.woke[0]?.conv).toBe("dm:1");
	});

	test("an ask outcome parks the row needs_input with its question", async () => {
		const { runs, settle, mkrow } = rig({
			outcome: { kind: "ask", question: "which env?", rev: 1 },
		});
		const row = mkrow();
		await settle.finalize(row.id, 1);
		const after = runs.get(row.id);
		expect(after?.status).toBe("needs_input");
		expect(after?.question).toBe("which env?");
	});

	test("an aborted outcome fails the row with the recorded reason", async () => {
		const { runs, settle, mkrow } = rig({
			outcome: { kind: "aborted", reason: "unsafe to retry", rev: 1 },
		});
		const row = mkrow();
		await settle.finalize(row.id, 1);
		const after = runs.get(row.id);
		expect(after?.status).toBe("failed");
		expect(after?.error).toBe("unsafe to retry");
	});

	test("a settle with no outcome and no unanswered reason names prose-is-never-a-completion", async () => {
		const { runs, settle, mkrow } = rig({ outcome: null });
		const row = mkrow();
		await settle.finalize(row.id, 1);
		const after = runs.get(row.id);
		expect(after?.status).toBe("failed");
		expect(after?.error).toMatch(/plain prose is never a completion/);
	});

	test("a stop-reason length reads as truncation, not refusal", async () => {
		const { runs, settle, mkrow } = rig({ outcome: null, stopReason: "length" });
		const row = mkrow();
		await settle.finalize(row.id, 1);
		expect(runs.get(row.id)?.error).toMatch(/output limit/);
	});

	test("an outcome recorded against an older rev never settles the newer input", async () => {
		const { runs, settle, mkrow } = rig({
			outcome: { kind: "done", result: "stale", files: [], rev: 1 },
		});
		const row = mkrow({ inputRev: 2 });
		await settle.finalize(row.id, 2);
		const after = runs.get(row.id);
		expect(after?.status).toBe("failed");
		expect(after?.result).toBeNull();
	});
});

describe("finalize — preemption", () => {
	test("persisted stop intent hands the transition to the stop path", async () => {
		const { runs, settle, mkrow, calls } = rig({
			outcome: { kind: "done", result: "too late", files: [], rev: 1 },
		});
		const row = mkrow({ stopRequested: true });
		await settle.finalize(row.id, 1);
		expect(runs.get(row.id)?.status).toBe("running");
		expect(calls.woke).toHaveLength(0);
	});

	test("a newer input owns settlement — the old finalize returns untouched", async () => {
		const { runs, settle, mkrow, calls } = rig({
			outcome: { kind: "done", result: "old", files: [], rev: 1 },
		});
		const row = mkrow({ inputRev: 2, inputIntent: "newer task" });
		await settle.finalize(row.id, 1);
		expect(runs.get(row.id)?.status).toBe("running");
		expect(calls.woke).toHaveLength(0);
	});
});

describe("completeStop", () => {
	test("aborts the Pi conversation, marks stopped, drops the gate, clears retry budgets", async () => {
		const { runs, settle, mkrow, calls, deps } = rig();
		const row = mkrow();
		deps.retryAfter.set(row.id, Date.now() + 9999);
		deps.admitAttempts.set(row.id, 3);
		await settle.completeStop(row.id);
		const after = runs.get(row.id);
		expect(after?.status).toBe("stopped");
		expect(calls.aborted).toBe(1);
		expect(calls.dropped).toEqual(["7"]);
		expect(deps.retryAfter.has(row.id)).toBe(false);
		expect(deps.admitAttempts.has(row.id)).toBe(false);
		expect(calls.woke).toHaveLength(1);
	});

	test("a closed harness can never confirm the stop — the intent stays standing", async () => {
		const { runs, settle, mkrow, flags } = rig();
		const row = mkrow({ stopRequested: true });
		flags.harnessClosed = true;
		await expect(settle.completeStop(row.id)).rejects.toThrow(/harness closed/);
		expect(runs.get(row.id)?.status).not.toBe("stopped");
	});
});

describe("notice", () => {
	test("a wake the origin refuses leaves noticePending for the scan retry", async () => {
		const { runs, settle, mkrow, deps } = rig();
		deps.wake = () => false;
		const row = mkrow({ status: "done", result: "r" });
		settle.notify(row);
		const after = runs.get(row.id);
		expect(after?.noticePending).toBe(true);
		expect(after?.noticeRev).toBe(1);
	});

	test("an admitted wake acks exactly its own rev", async () => {
		const { runs, settle, mkrow } = rig();
		const row = mkrow({ status: "done", result: "r" });
		settle.notify(row);
		expect(runs.get(row.id)?.noticePending).toBe(false);
		settle.notify(runs.get(row.id)!);
		expect(runs.get(row.id)?.noticeRev).toBe(2);
	});
});

describe("monitor", () => {
	test("a settled submission runs finalize through the lane; a failed wait lands in recoveryPending", async () => {
		const { runs, settle, mkrow, deps } = rig({
			outcome: { kind: "done", result: "watched", files: [], rev: 1 },
		});
		const row = mkrow();
		const submission = {
			wait: async () => ({ status: "answered" }),
		} as unknown as Submission;
		settle.monitor(row.id, 1, submission);
		expect(settle.monitored(row.id)).toBe(true);
		await Promise.all(settle.pendingMonitors());
		expect(runs.get(row.id)?.status).toBe("done");

		const failed = mkrow();
		const bad = {
			wait: async () => {
				throw new Error("stream died");
			},
		} as unknown as Submission;
		settle.monitor(failed.id, 1, bad);
		await Promise.allSettled(settle.pendingMonitors());
		expect(deps.recoveryPending.has(failed.id)).toBe(true);
		expect(deps.recoveryAttempts.get(failed.id)?.lastError).toBe("stream died");
	});
});
