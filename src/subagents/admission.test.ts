// admission.ts boundary tests — the admit verdict taxonomy the
// scheduler speaks (design/subagents.md → Owner decomposition;
// Admission). The run store is real; the harness is a stub because
// the pinned invariants live on the goblin side of the line:
// halted vs blocked vs requeued vs admitted, the durable
// requestId's idempotent resubmit, the parked-approval
// continuation, and the retry budget's terminal settle.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Submission } from "@earendil-works/pi-durable";
import { DesktopLeaseError } from "../desktops.ts";
import type { Desktops } from "../desktops.ts";
import { openSubagentRuns, type SubagentRun, type SubagentRuns } from "../subagent-runs.ts";
import { SubagentError } from "./errors.ts";
import { makeAdmission, type AdmissionDeps } from "./admission.ts";
import { makeApprovalGate } from "./approval-gate.ts";
import type { KindSpec } from "./models.ts";
import { makeRowAccess } from "./row-access.ts";
import type { HarnessBundle } from "./tools.ts";

const dirs: string[] = [];
const stores: SubagentRuns[] = [];
afterEach(() => {
	for (const s of stores) s.close();
	stores.length = 0;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

const SPEC = {
	kind: "worker",
	providerId: "p",
	modelId: "m",
	thinking: "off",
	catalog: {},
} as unknown as KindSpec;

interface HarnessStub {
	conversationsCreated: number;
	submits: { content: unknown; requestId?: string }[];
	// Test knobs — undefined answers drive the failure branches.
	conversationResult: unknown;
	submissionByRequestResult: unknown;
	createConversationError?: Error;
}

function stubHarness(over: Partial<HarnessStub> = {}): {
	bundle: HarnessBundle;
	stub: HarnessStub;
} {
	const stub: HarnessStub = {
		conversationsCreated: 0,
		submits: [],
		conversationResult: {
			submit: async (req: { content: unknown; requestId?: string }) => {
				stub.submits.push(req);
				return { id: "sub-9" } as unknown as Submission;
			},
		},
		submissionByRequestResult: undefined,
		...over,
	};
	const harness = {
		createConversation: async () => {
			stub.conversationsCreated += 1;
			if (stub.createConversationError) throw stub.createConversationError;
			return { id: 7 };
		},
		conversation: async () => stub.conversationResult,
		submission: async (id: unknown) =>
			(id === 55 ? { id: 55 } : undefined) as unknown as Submission,
		commit: async (fn: (tx: unknown) => unknown) =>
			fn({ submissionByRequest: async () => stub.submissionByRequestResult }),
		resume: () => {},
	};
	return {
		bundle: { harness, workerExtension: {}, computerExtension: {} } as unknown as HarnessBundle,
		stub,
	};
}

function rig(opts: { harness?: HarnessBundle; desktops?: Desktops; admitRetryMs?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-adm-"));
	dirs.push(dir);
	const runs = openSubagentRuns(join(dir, "runs.sqlite"));
	stores.push(runs);
	const flags = { closing: false, resumed: false, harnessClosed: false };
	const access = makeRowAccess({
		runs,
		isClosing: () => flags.closing,
		isHarnessClosed: () => flags.harnessClosed,
	});
	const calls = { notified: 0, released: 0, drains: 0, monitored: [] as number[] };
	const shared = {
		recoveryPending: new Set<number>(),
		recoveryAttempts: new Map<number, { count: number; lastError: string }>(),
		retryAfter: new Map<number, number>(),
		admitAttempts: new Map<number, number>(),
	};
	const gate = makeApprovalGate({
		runs,
		rowForConversation: access.rowForConversation,
		recordOutcome: async () => {},
		notify: () => {},
		releaseLeases: () => {},
		scheduleDrain: () => {},
		abortConversation: async () => {},
	});
	const deps: AdmissionDeps = {
		runs,
		desktops:
			opts.desktops ?? ({ claim: async () => ({ note: "claimed" }) } as unknown as Desktops),
		access,
		harnessBundle: () => opts.harness ?? stubHarness().bundle,
		refFor: () => SPEC,
		importFiles: async () => ["inbox/f1"],
		monitor: (rowId) => {
			calls.monitored.push(rowId);
		},
		monitored: () => false,
		gate,
		releaseLeases: () => {
			calls.released += 1;
		},
		notify: () => {
			calls.notified += 1;
		},
		scheduleDrain: () => {
			calls.drains += 1;
		},
		...shared,
		admitRetryMs: opts.admitRetryMs,
		isClosing: () => flags.closing,
		isResumed: () => flags.resumed,
		isHarnessClosed: () => flags.harnessClosed,
	};
	const admission = makeAdmission(deps);
	const mkrow = (patch: Partial<Parameters<SubagentRuns["update"]>[1]> = {}, kind = "worker") => {
		const row = runs.create({
			kind: kind as SubagentRun["kind"],
			conversationId: "dm:1",
			workspace: "/w",
			task: "t",
			desktop: kind === "computer" ? "d0" : null,
		});
		return runs.update(row.id, { status: "queued", ...patch });
	};
	return { runs, admission, mkrow, calls, shared, gate, flags };
}

describe("admit verdicts", () => {
	test("a stopping row answers halted before any external effect", async () => {
		const { admission, mkrow } = rig();
		const row = mkrow({ stopRequested: true });
		expect(await admission.admit(row)).toEqual({ kind: "halted" });
	});

	test("a computer run whose desktop claim refuses answers blocked with a retry timer", async () => {
		const desktops = {
			claim: async () => {
				throw new DesktopLeaseError("desktop held by run 3");
			},
		} as unknown as Desktops;
		const { admission, mkrow, shared } = rig({ desktops });
		const row = mkrow({ status: "queued" }, "computer");
		const out = await admission.admit(row);
		expect(out.kind).toBe("blocked");
		expect(out.kind === "blocked" && out.reason).toMatch(/held by run 3/);
		expect(shared.retryAfter.has(row.id)).toBe(true);
	});

	test("preserveRunning keeps the blocked verdict but skips the retry bookkeeping", async () => {
		const desktops = {
			claim: async () => {
				throw new DesktopLeaseError("held");
			},
		} as unknown as Desktops;
		const { admission, mkrow, shared } = rig({ desktops });
		const row = mkrow({}, "computer");
		expect((await admission.admit(row, true)).kind).toBe("blocked");
		expect(shared.retryAfter.has(row.id)).toBe(false);
	});

	test("a queued approval without a persisted decision answers blocked", async () => {
		const { admission, mkrow } = rig();
		const row = mkrow({
			piConversationId: "7",
			pendingApproval: { piTaskId: "t1", callId: "c1", tool: "bash", args: {}, attempts: 1 },
		});
		const out = await admission.admit(row);
		expect(out).toMatchObject({ kind: "blocked", reason: "no persisted approval decision" });
	});

	test("a queued approval with a decision admits: row flips running, mirror clears, verdict stored for re-entry", async () => {
		const { admission, mkrow, runs, gate } = rig();
		const row = mkrow({
			piConversationId: "7",
			// A parked run was running before the park — its submission
			// id survives for the settlement watcher to reacquire.
			piSubmissionId: "55",
			pendingApproval: {
				piTaskId: "t1",
				callId: "c1",
				tool: "bash",
				args: {},
				attempts: 1,
				decision: { kind: "authorize-retry", evidence: "e", reasoning: "r" },
			},
		});
		expect(await admission.admit(row)).toEqual({ kind: "admitted" });
		const after = runs.get(row.id);
		expect(after?.status).toBe("running");
		expect(after?.pendingApproval).toBeNull();
		// No waiter existed — the verdict is stored for the gate's
		// post-restart re-entry: a second admit of a claimed lease
		// would consume it. Direct evidence: storeDecision lands in
		// the same map takeWaiter reads.
		expect(gate.takeWaiter(gate.approvalKey("7", "t1"))).toBeUndefined();
	});
});

describe("the submit path", () => {
	test("a fresh worker submits with the durable requestId and persists the submission id", async () => {
		const { bundle, stub } = stubHarness();
		const { admission, mkrow, runs, calls } = rig({ harness: bundle });
		const row = mkrow({ piConversationId: "7" });
		expect(await admission.admit(row)).toEqual({ kind: "admitted" });
		expect(stub.submits).toHaveLength(1);
		expect(stub.submits[0]?.requestId).toBe(`subagent:${row.id}:input:1`);
		const after = runs.get(row.id);
		expect(after?.piSubmissionId).toBe("sub-9");
		expect(after?.status).toBe("running");
		expect(calls.monitored).toEqual([row.id]);
	});

	test("an already-recorded requestId reacquires its submission instead of re-submitting", async () => {
		const { bundle, stub } = stubHarness({
			submissionByRequestResult: { id: 55 },
		});
		const { admission, mkrow, runs } = rig({ harness: bundle });
		const row = mkrow({ piConversationId: "7" });
		expect(await admission.admit(row)).toEqual({ kind: "admitted" });
		expect(stub.submits).toHaveLength(0);
		expect(runs.get(row.id)?.piSubmissionId).toBe("55");
	});

	test("a vanished Pi conversation requeues a row that still owns its slot", async () => {
		const { bundle } = stubHarness({ conversationResult: undefined });
		const { admission, mkrow, runs, shared } = rig({ harness: bundle });
		const row = mkrow({ piConversationId: "7" });
		const out = await admission.admit(row);
		expect(out.kind).toBe("requeued");
		// The row stays running and owned — a submission may have
		// landed before the error; scan recovery drives the re-admit.
		expect(runs.get(row.id)?.status).toBe("running");
		expect(shared.recoveryPending.has(row.id)).toBe(true);
	});
});

describe("the retry budget", () => {
	test("a fresh-conversation failure requeues with backoff, then settles terminal at the attempt bound", async () => {
		const { bundle } = stubHarness({ createConversationError: new Error("provider down") });
		const { admission, mkrow, runs, calls, shared } = rig({
			harness: bundle,
			admitRetryMs: 1,
		});
		const row = mkrow();
		// Attempts 1..4 requeue queued with backoff; attempt 5 fails terminal.
		for (let i = 1; i <= 4; i++) {
			const out = await admission.admit(row);
			expect(out.kind).toBe("requeued");
			expect(runs.get(row.id)?.status).toBe("queued");
			expect(shared.admitAttempts.get(row.id)).toBe(i);
		}
		const out = await admission.admit(row);
		expect(out.kind).toBe("halted");
		const after = runs.get(row.id);
		expect(after?.status).toBe("failed");
		expect(after?.error).toMatch(/after 5 attempts/);
		expect(calls.notified).toBe(1);
		expect(calls.released).toBe(1);
	});
});

describe("readmitOutcome", () => {
	test("requeued surfaces loudly; blocked defers to scan recovery; admitted is silent", () => {
		const { admission, mkrow, shared } = rig();
		const row = mkrow({ status: "running", piConversationId: "7" });
		expect(() => admission.readmitOutcome(row, { kind: "requeued", reason: "nope" })).toThrow(
			SubagentError,
		);
		admission.readmitOutcome(row, { kind: "blocked", reason: "lease held" });
		expect(shared.recoveryPending.has(row.id)).toBe(true);
		expect(shared.recoveryAttempts.get(row.id)?.lastError).toBe("lease held");
		expect(() => admission.readmitOutcome(row, { kind: "admitted" })).not.toThrow();
	});
});
