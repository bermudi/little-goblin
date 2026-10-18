// Admission — the one path that lands input on a Pi conversation,
// for all three modes: initial (task), resume (needs_input answer),
// steer (live input) and the parked-approval continuation. Extracted
// from mod.ts verbatim (design/subagents.md → Owner decomposition);
// every step re-checks the persisted row before the next external
// effect, and the durable requestId `subagent:<id>:input:<rev>` makes
// a re-submit return the same admitted submission.

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Submission } from "@earendil-works/pi-durable";
import type { Desktops } from "../desktops.ts";
import { log } from "../log.ts";
import { subagentTaskInput, COMPUTER_PROMPT, WORKER_PROMPT } from "../subagent-prompts.ts";
import {
	type InputMode,
	type SubagentKind,
	type SubagentRun,
	type SubagentRuns,
} from "../subagent-runs.ts";
import { DesktopLeaseError } from "../desktops.ts";
import type { ApprovalGate } from "./approval-gate.ts";
import { SubagentError } from "./errors.ts";
import type { KindSpec } from "./models.ts";
import { RunDoc } from "./run-doc.ts";
import type { RowAccess } from "./row-access.ts";
import type { HarnessBundle } from "./tools.ts";

const ctx: Context = BACKGROUND_CONTEXT;
const LEASE_RETRY_MS = 5_000;
// Transient admission failures re-queue the run with exponential
// backoff off this base; only the attempt bound settles it terminal.
const ADMIT_MAX_ATTEMPTS = 5;
const ADMIT_RETRY_BASE_MS = 5_000;

export interface AdmissionDeps {
	runs: SubagentRuns;
	desktops: Desktops;
	access: RowAccess;
	/** The bundle binds only at buildHarness — resolved per admit. */
	harnessBundle: () => HarnessBundle;
	refFor: (kind: SubagentKind) => KindSpec;
	importFiles: (row: SubagentRun) => Promise<string[]>;
	monitor: (rowId: number, rev: number, submission: Submission) => void;
	monitored: (rowId: number) => boolean;
	gate: ApprovalGate;
	releaseLeases: (row: SubagentRun) => void;
	notify: (row: SubagentRun) => void;
	scheduleDrain: () => void;
	/** Shared run-scoped maps — recovery writes them too. */
	recoveryPending: Set<number>;
	recoveryAttempts: Map<number, { count: number; lastError: string }>;
	retryAfter: Map<number, number>;
	admitAttempts: Map<number, number>;
	/** Test seam: base delay (ms) for admission-retry backoff. */
	admitRetryMs: number | undefined;
	isClosing: () => boolean;
	isResumed: () => boolean;
	isHarnessClosed: () => boolean;
}

// Admit's verdict distinguishes the non-admissions callers must
// answer differently: "halted" means stop/close owns the row,
// "blocked" is a lease conflict carrying the reason — a caller that
// persisted an intent must roll it back or keep it pending, since
// drain only retries queued rows — and "requeued" means a transient
// failure deferred THIS admission: the intent stays persisted and
// the retry path (drain backoff for a queued row, scan recovery for
// a live one) owns it, so callers must not roll back.
export type AdmitOutcome =
	| { kind: "admitted" }
	| { kind: "halted" }
	| { kind: "blocked"; reason: string }
	| { kind: "requeued"; reason: string };

export interface Admission {
	admit(row: SubagentRun, preserveRunning?: boolean): Promise<AdmitOutcome>;
	readmitOutcome(row: SubagentRun, outcome: AdmitOutcome): void;
}

export function makeAdmission(deps: AdmissionDeps): Admission {
	return {
		admit: (row, preserveRunning) => admit(deps, row, preserveRunning),
		readmitOutcome: (row, outcome) => readmitOutcome(deps, row, outcome),
	};
}

// One admission path for all three input modes: initial (task),
// resume (needs_input answer) and steer (live input). Every step
// re-checks the persisted row before the next external effect.
async function admit(
	deps: AdmissionDeps,
	row: SubagentRun,
	preserveRunning = false,
): Promise<AdmitOutcome> {
	const {
		runs,
		harnessBundle,
		refFor,
		importFiles,
		monitor,
		monitored,
		gate,
		releaseLeases,
		notify,
		scheduleDrain,
		recoveryPending,
		retryAfter,
		admitAttempts,
		isClosing,
		isResumed,
		isHarnessClosed,
	} = deps;
	const { holderFor, persistClaimNote, throwIfHalted, asConv, asSub } = deps.access;
	const admitRetryBaseMs = deps.admitRetryMs ?? ADMIT_RETRY_BASE_MS;
	const t0 = Date.now();
	try {
		if (row.kind === "computer") {
			if (row.desktop === null) throw new SubagentError("computer run without a desktop");
			try {
				const claimed = await deps.desktops.claim(row.desktop, holderFor(row.id));
				persistClaimNote(row.id, claimed.note);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (preserveRunning) {
					log.warn("subagent steer claim rejected — the live run keeps the desktop", err, {
						run: row.id,
						desktop: row.desktop,
					});
					return { kind: "blocked", reason: msg };
				}
				if (err instanceof DesktopLeaseError) {
					retryAfter.set(row.id, Date.now() + LEASE_RETRY_MS);
					return { kind: "blocked", reason: msg };
				}
				throw err;
			}
		}
		throwIfHalted(row.id);
		const { harness, workerExtension, computerExtension } = harnessBundle();
		let piConv = row.piConversationId;
		if (piConv === null) {
			const spec = refFor(row.kind);
			const conv = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: {
						model: { provider: spec.providerId, modelId: spec.modelId },
						thinkingLevel: spec.thinking,
						extensions: [row.kind === "worker" ? workerExtension : computerExtension],
						instructions: row.kind === "worker" ? WORKER_PROMPT : COMPUTER_PROMPT,
					},
					init: async (tx, conversationId) => {
						const d = await tx.doc(RunDoc, conversationId);
						d.runId = row.id;
					},
				},
				ctx,
			);
			piConv = String(conv.id);
			runs.update(row.id, { piConversationId: piConv });
		}
		throwIfHalted(row.id);
		let fresh = runs.get(row.id)!;
		if (fresh.inbox.length === 0 && fresh.files.length > 0) {
			const inbox = await importFiles(fresh);
			runs.update(row.id, { inbox });
			fresh = runs.get(row.id)!;
		}
		throwIfHalted(row.id);
		if (fresh.pendingApproval !== null) {
			// An approval continuation rides the parked tool task — no
			// new input submits. Capacity and the resource gates above
			// already passed, so the durable verdict can release the
			// gate: the row flips running so the gate's requireLive
			// sees it, then the parked waiter resolves or the verdict
			// stores for the post-restart re-entry.
			if (fresh.piConversationId === null) {
				throw new SubagentError("queued approval run has no Pi conversation — corrupt park");
			}
			const d = fresh.pendingApproval.decision;
			if (d === undefined) {
				// decide() writes the verdict + audit and queues in one
				// update — an empty one is a wedged row, not a slot to burn.
				retryAfter.set(row.id, Date.now() + LEASE_RETRY_MS);
				return { kind: "blocked", reason: "no persisted approval decision" };
			}
			let sub: Submission | undefined;
			if (!monitored(row.id)) {
				sub =
					fresh.piSubmissionId === null
						? undefined
						: await harness.submission(asSub(fresh.piSubmissionId), ctx);
				if (sub === undefined) {
					retryAfter.set(row.id, Date.now() + LEASE_RETRY_MS);
					return {
						kind: "blocked",
						reason: "parked call's submission could not be reacquired",
					};
				}
			}
			throwIfHalted(row.id);
			const key = gate.approvalKey(fresh.piConversationId, fresh.pendingApproval.piTaskId);
			runs.update(row.id, { status: "running", pendingApproval: null });
			const waiter = gate.takeWaiter(key);
			if (waiter === undefined) {
				// No invocation is waiting — the gate re-enters on
				// harness.resume().
				gate.storeDecision(key, d);
			}
			// The parked submission needs a settlement watcher on BOTH
			// paths. A waiter registered by this process's parked
			// invocation already has one (its monitor is mid-wait — a
			// parked tool task cannot settle its submission); but a
			// restart-registered waiter rode harness recovery, which
			// attached no monitor — boot skips queued rows — and the
			// no-waiter path re-enters the gate only after this. The
			// watcher attaches before the waiter resolves or the
			// scheduler runs, or the continuation settles unwatched
			// and leaks its slot forever.
			if (sub !== undefined) monitor(row.id, fresh.inputRev, sub);
			if (waiter !== undefined) {
				waiter(d);
			} else if (isResumed() && !isHarnessClosed()) {
				harness.resume();
			}
			log.info("subagent approval decision admitted — the parked call continues", {
				run: row.id,
				piTaskId: fresh.pendingApproval.piTaskId,
				tool: fresh.pendingApproval.tool,
				kind: d.kind,
				waiter: waiter !== undefined,
			});
			return { kind: "admitted" };
		}
		// Persist the input intent + revision BEFORE admit: a crash
		// between submit and row write re-submits the same requestId
		// and gets the already-admitted submission back.
		const mode: InputMode = fresh.inputIntent !== null ? (fresh.inputMode ?? "initial") : "initial";
		const rev = fresh.inputIntent === null ? fresh.inputRev + 1 : fresh.inputRev;
		const text = fresh.inputIntent ?? subagentTaskInput(fresh.task, fresh.inbox);
		runs.update(row.id, {
			inputRev: rev,
			inputIntent: text,
			inputMode: mode,
			status: "running",
		});
		throwIfHalted(row.id);
		const conv = await harness.conversation(asConv(piConv), ctx);
		if (conv === undefined) throw new SubagentError("Pi conversation vanished");
		// The doc is NOT touched here: inputRev means the input a
		// request actually consumed, which only the transcript
		// checkpoint can say — requestGuard binds it just before
		// the provider call. A queued or blocked steer must never
		// stamp its revision over the in-flight one.
		throwIfHalted(row.id);
		const requestId = `subagent:${row.id}:input:${rev}`;
		const prior = await harness.commit(
			(tx) => tx.submissionByRequest(asConv(piConv!), requestId),
			ctx,
		);
		const submission =
			prior !== undefined
				? ((await harness.submission(prior.id, ctx)) ??
					(await conv.submit(
						{
							type: "input",
							content: text,
							requestId,
							...(mode === "steer" ? { whenBusy: "steer" as const } : {}),
						},
						ctx,
					)))
				: await conv.submit(
						{
							type: "input",
							content: text,
							requestId,
							...(mode === "steer" ? { whenBusy: "steer" as const } : {}),
						},
						ctx,
					);
		runs.update(row.id, {
			piSubmissionId: String(submission.id),
			inputIntent: null,
			inputMode: null,
		});
		log.info("subagent admitted", {
			run: row.id,
			kind: row.kind,
			mode,
			conversation: row.conversationId,
			inputRev: rev,
			ms: Date.now() - t0,
		});
		admitAttempts.delete(row.id);
		retryAfter.delete(row.id);
		monitor(row.id, rev, submission);
		return { kind: "admitted" };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg === "stopped" || msg === "owner closing" || msg === "run row vanished") {
			return { kind: "halted" };
		}
		if (isClosing() || runs.get(row.id)?.stopRequested === true) return { kind: "halted" };
		// A row that settled while this admission failed must never be
		// resurrected queued — only a still-unsettled row retries.
		const cur = runs.get(row.id);
		if (
			cur === null ||
			cur.stopRequested ||
			(cur.status !== "queued" && cur.status !== "running")
		) {
			return { kind: "halted" };
		}
		if (preserveRunning || cur.piConversationId !== null) {
			// A recorded Pi conversation means a submission may have
			// landed before the error — even a thrown submit can be a
			// lost ack. The row stays running and owned: the persisted
			// intent, the revision, the global slot and the retry
			// budgets are retained, and the scan's bounded recovery
			// drives the idempotent re-admit — only a confirmed
			// cancellation there can settle the row terminal.
			if (cur.status !== "running") {
				runs.update(row.id, { status: "running" });
			}
			admitAttempts.delete(row.id);
			retryAfter.delete(row.id);
			recoveryPending.add(row.id);
			log.warn(
				"subagent admission failed past a recorded Pi conversation — the row stays owned; scan recovery retries",
				err,
				{ run: row.id },
			);
			return { kind: "requeued", reason: msg };
		}
		// No Pi conversation is recorded, so no submission can have
		// landed — a queued retry with backoff is safe, and exhausting
		// the bounded budget may settle terminally without confirming
		// a cancellation. The drain microtask would fire before the
		// backoff expires and find nothing eligible — a timer wakes it
		// when the row is due instead of waiting out a scan interval.
		const attempts = (admitAttempts.get(row.id) ?? 0) + 1;
		if (attempts < ADMIT_MAX_ATTEMPTS) {
			admitAttempts.set(row.id, attempts);
			const delay = admitRetryBaseMs * 2 ** (attempts - 1);
			retryAfter.set(row.id, Date.now() + delay);
			runs.update(row.id, { status: "queued" });
			log.warn("subagent admission failed — re-queued for retry", err, {
				run: row.id,
				attempt: attempts,
				maxAttempts: ADMIT_MAX_ATTEMPTS,
				retryInMs: delay,
			});
			setTimeout(scheduleDrain, delay).unref?.();
			scheduleDrain();
			return { kind: "requeued", reason: msg };
		}
		admitAttempts.delete(row.id);
		retryAfter.delete(row.id);
		log.error("subagent admission failed terminally", err, { run: row.id, attempts });
		const failed = runs.update(row.id, {
			status: "failed",
			error: `admission failed after ${attempts} attempts: ${msg}`,
			noticePending: true,
			finishedAt: Date.now(),
		});
		releaseLeases(failed);
		notify(failed);
		return { kind: "halted" };
	}
}

// A re-admit verdict for a live row never demotes it to queued —
// its persisted intent and running slot are retained because Pi
// work for the row may still be live; the scan's recovery path is
// the retry vehicle for both a refused lease and a failed re-admit.
// A "requeued" outcome is surfaced so the scan counts the attempt.
function readmitOutcome(deps: AdmissionDeps, row: SubagentRun, outcome: AdmitOutcome): void {
	if (outcome.kind === "requeued") {
		throw new SubagentError(`re-admission could not land: ${outcome.reason}`);
	}
	if (outcome.kind === "blocked") {
		deps.recoveryAttempts.set(row.id, {
			count: deps.recoveryAttempts.get(row.id)?.count ?? 0,
			lastError: outcome.reason,
		});
		deps.recoveryPending.add(row.id);
		log.warn("subagent re-admit blocked by a held lease — the running row keeps its slot", {
			run: row.id,
			reason: outcome.reason,
		});
	}
}
