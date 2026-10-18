// Recovery — scan-driven repair for rows whose Pi side is uncertain
// (design/subagents.md → Owner decomposition): re-drive a persisted
// input intent after a transient claim abort, reattach a monitor to
// a still-live submission, re-park an approval waiter, and only then
// settle terminal — a recorded Pi conversation means a submission may
// be executing, so the confirm-cancel proves ownership before the row
// may release its slot. Extracted verbatim from mod.ts.

import type { Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Submission } from "@earendil-works/pi-durable";
import { log } from "../log.ts";
import type { SubagentRun, SubagentRuns } from "../subagent-runs.ts";
import type { Admission } from "./admission.ts";
import type { ApprovalGate } from "./approval-gate.ts";
import { SubagentError } from "./errors.ts";
import { RunDoc } from "./run-doc.ts";
import type { RowAccess } from "./row-access.ts";
import type { HarnessBundle } from "./tools.ts";

const ctx: Context = BACKGROUND_CONTEXT;
// Recovery (re-attaching a dead monitor) retries once per scan; past
// this many consecutive failures the run settles failed — no lifecycle
// path may hold its slot and lease forever.
const RECOVERY_MAX_ATTEMPTS = 10;
// Re-drive input after a transient claim failure aborted a request.
// It is goblin-voiced, not operator-voiced: the real input is already
// a transcript entry, so the nudge only asks the run to continue.
const RECOVERY_NUDGE =
	"[goblin] The previous model request aborted on transient infrastructure — your input is already in the transcript; continue the task.";

export interface RecoveryDeps {
	runs: SubagentRuns;
	lane: <T>(id: number, fn: () => Promise<T>) => Promise<T>;
	harness: HarnessBundle["harness"];
	access: RowAccess;
	admission: Admission;
	monitor: (rowId: number, rev: number, submission: Submission) => void;
	finalize: (rowId: number, rev: number) => Promise<void>;
	gate: ApprovalGate;
	releaseLeases: (row: SubagentRun) => void;
	notify: (row: SubagentRun) => void;
	scheduleDrain: () => void;
	/** Shared run-scoped maps — monitor/admission write them too. */
	recoveryPending: Set<number>;
	recoveryAttempts: Map<number, { count: number; lastError: string }>;
	isClosing: () => boolean;
	isHarnessClosed: () => boolean;
}

export interface Recovery {
	/** The request guard's transient-claim hook (buildHarness dep). */
	nudge(rowId: number, inputRev: number, context: Context): Promise<void>;
	recoverRun(boot: SubagentRun): Promise<void>;
	recoverParked(id: number): Promise<void>;
	/** One scan pass over the recovery-pending set. */
	drive(): Promise<void>;
}

export function makeRecovery(deps: RecoveryDeps): Recovery {
	return {
		nudge: (rowId, inputRev, context) => nudge(deps, rowId, inputRev, context),
		recoverRun: (boot) => recoverRun(deps, boot),
		recoverParked: (id) => recoverParked(deps, id),
		drive: () => drive(deps),
	};
}

// The request guard's transient desktop-claim path, owned here so the
// hook never reaches into owner state: persist the nudge intent at a
// fresh rev and mark the row recovery-pending. Cancellation may hold
// the lane while joining the hook — cancel only the waiter, not the
// lane operation; it must still serialize behind any provisional
// steer.
async function nudge(
	deps: RecoveryDeps,
	rowId: number,
	inputRev: number,
	context: Context,
): Promise<void> {
	await awaitWithContext(
		deps.lane(rowId, async () => {
			const cur = deps.runs.get(rowId);
			if (
				context.abortSignal?.aborted ||
				cur === null ||
				cur.status !== "running" ||
				cur.stopRequested
			)
				return;
			if (cur.inputIntent === null && cur.inputRev === inputRev) {
				deps.runs.update(rowId, {
					inputRev: cur.inputRev + 1,
					inputIntent: RECOVERY_NUDGE,
					inputMode: null,
				});
			}
			deps.recoveryPending.add(rowId);
		}),
		context,
	);
}

// Terminal settling past a recorded Pi conversation is only allowed
// once the conversation is proven dead — the failed step may already
// have landed a submission that is still executing. A missing
// conversation IS the proof; a failed lookup/abort/join is not, so
// callers get false and keep the row owned and recovery-pending
// rather than releasing a slot Pi may still be burning.
async function confirmPiIdle(
	deps: RecoveryDeps,
	rowId: number,
	piConversationId: string,
): Promise<boolean> {
	if (deps.isHarnessClosed()) return false;
	try {
		const conv = await deps.harness.conversation(deps.access.asConv(piConversationId), ctx);
		if (conv === undefined) return true;
		await conv.abort(ctx, { background: true });
		await conv.waitForIdle(ctx);
		return true;
	} catch (err) {
		log.warn("Pi cancellation could not be confirmed — the run stays owned", err, {
			run: rowId,
			conversation: piConversationId,
		});
		return false;
	}
}

async function recoverRun(deps: RecoveryDeps, boot: SubagentRun): Promise<void> {
	const { runs, lane, harness, access, admission, monitor, finalize } = deps;
	const { asConv, asSub } = access;
	const rev = await lane(boot.id, async (): Promise<number | undefined> => {
		const live = (): SubagentRun | null => {
			if (deps.isClosing() || deps.isHarnessClosed()) return null;
			const row = runs.get(boot.id);
			return row !== null && row.status === "running" && !row.stopRequested ? row : null;
		};
		let row = live();
		if (row === null) return undefined;
		const piConv = row.piConversationId;
		if (piConv === null) {
			if (row.inputIntent !== null) {
				// Admission died before the conversation id landed —
				// re-admit from the persisted intent.
				runs.update(row.id, { status: "queued" });
			} else {
				runs.update(row.id, {
					status: "failed",
					error: "no Pi conversation recorded",
					noticePending: true,
					finishedAt: Date.now(),
				});
			}
			return undefined;
		}
		const conv = await harness.conversation(asConv(piConv), ctx);
		row = live();
		if (row === null) return undefined;
		if (conv === undefined) {
			runs.update(row.id, {
				status: "failed",
				error: "Pi conversation missing after restart",
				noticePending: true,
				finishedAt: Date.now(),
			});
			return undefined;
		}
		if (row.inputIntent !== null) {
			// A persisted answer/steer the row never received —
			// re-admit through the idempotent path, preserving the
			// running slot: the earlier submission may be live.
			admission.readmitOutcome(row, await admission.admit(row, true));
			return undefined;
		}
		const doc = await harness.snapshot(RunDoc, asConv(piConv), ctx);
		row = live();
		if (row === null) return undefined;
		const outcome = doc?.outcome ?? null;
		if (outcome !== null && outcome.rev === row.inputRev) {
			return row.inputRev;
		}
		// A stale outcome belongs to an older input — the
		// latest submission still owns settlement.
		if (row.piSubmissionId !== null) {
			const sub = await harness.submission(asSub(row.piSubmissionId), ctx);
			row = live();
			if (row === null) return undefined;
			if (sub !== undefined) {
				monitor(row.id, row.inputRev, sub);
				return undefined;
			}
		}
		// No reacquirable submission — idempotent re-admission
		// finds the admitted requestId or admits once, without
		// ever demoting the live row to queued.
		admission.readmitOutcome(row, await admission.admit(row, true));
		return undefined;
	});
	if (rev !== undefined) await finalize(boot.id, rev);
}

// An approval-parked row's durable half is a still-live tool task:
// once scheduling resumes the gate re-enters it and the host
// re-parks — but the submission's monitor must already be attached,
// or a decided run settles with nobody watching and leaks its slot.
// The lane read keeps this honest against a decide() racing boot.
async function recoverParked(deps: RecoveryDeps, id: number): Promise<void> {
	const { runs, lane, harness, monitor } = deps;
	const { asSub } = deps.access;
	await lane(id, async () => {
		const row = runs.get(id);
		if (
			row === null ||
			row.stopRequested ||
			(row.status !== "needs_input" && row.status !== "queued") ||
			row.pendingApproval === null
		) {
			return;
		}
		if (row.piSubmissionId === null) {
			throw new SubagentError("parked run has no Pi submission — corrupt park");
		}
		const sub = await harness.submission(asSub(row.piSubmissionId), ctx);
		if (sub === undefined) {
			throw new SubagentError("the parked call's Pi submission could not be reacquired");
		}
		monitor(row.id, row.inputRev, sub);
	});
}

// The ordinary retry budget is spent — but settling terminal is
// only allowed once Pi's side is confirmed dead: a recovered step
// may have landed a submission that is still executing. Cancelling
// is ownership proof, not permission to release — an unconfirmed
// cancel keeps the row running, owned and pending. The whole
// confirm-and-fail runs in the per-run lane: a send or finalize
// holding it must complete (or see the terminal row) rather than
// interleave a new submission between the abort and the update.
async function exhaustRecovery(
	deps: RecoveryDeps,
	id: number,
	attempts: number,
	msg: string,
	err: unknown,
): Promise<void> {
	const { runs, lane, gate, releaseLeases, notify, recoveryPending, recoveryAttempts } = deps;
	const settled = await lane(id, async (): Promise<boolean> => {
		if (deps.isClosing() || deps.isHarnessClosed()) return false;
		const live = runs.get(id);
		const parked =
			live !== null &&
			(live.status === "needs_input" || live.status === "queued") &&
			live.pendingApproval !== null;
		if (live === null || live.stopRequested || (live.status !== "running" && !parked)) {
			return true;
		}
		if (live.piConversationId !== null && !(await confirmPiIdle(deps, id, live.piConversationId))) {
			recoveryPending.add(id);
			log.error(
				"subagent recovery exhausted but Pi cancellation is unconfirmed — the run stays owned",
				err,
				{ run: id, attempts },
			);
			return false;
		}
		// A close landing during the confirmed cancel keeps the row
		// owned — the next boot's scan owns the terminal decision,
		// not a wedged process.
		if (deps.isClosing() || deps.isHarnessClosed()) {
			recoveryPending.add(id);
			return false;
		}
		const afterCancel = runs.get(id);
		const stillParked =
			afterCancel !== null &&
			(afterCancel.status === "needs_input" || afterCancel.status === "queued") &&
			afterCancel.pendingApproval !== null;
		if (
			afterCancel === null ||
			afterCancel.stopRequested ||
			(afterCancel.status !== "running" && !stillParked)
		) {
			// A stop landing during the cancel owns the transition.
			return true;
		}
		log.error("subagent recovery exhausted — settling the run failed", err, {
			run: id,
			attempts,
		});
		const failed = runs.update(id, {
			status: "failed",
			error: `recovery failed after ${attempts} attempts: ${msg}`,
			noticePending: true,
			finishedAt: Date.now(),
			pendingApproval: null,
		});
		if (afterCancel.piConversationId !== null)
			gate.dropForConversation(afterCancel.piConversationId);
		releaseLeases(failed);
		notify(failed);
		return true;
	}).catch((error: unknown) => {
		// No monitor remains to retry a failed terminal write.
		recoveryPending.add(id);
		throw error;
	});
	if (settled) recoveryAttempts.delete(id);
}

// One scan pass over recovery-pending rows. Every pickup spends one
// bounded attempt. A recoverRun that returns is only provisional — it
// may have merely attached a replacement monitor or re-parked a
// blocked readmit — so the count clears on observed settlement (a
// monitor completing, or the row leaving running), never on the
// attempt's return alone.
async function drive(deps: RecoveryDeps): Promise<void> {
	const { runs, recoveryPending, recoveryAttempts, scheduleDrain } = deps;
	for (const id of [...recoveryPending]) {
		if (deps.isClosing() || deps.isHarnessClosed()) break;
		let attempts = 0;
		let lastError = "";
		let exhausted = false;
		try {
			recoveryPending.delete(id);
			const row = runs.get(id);
			// needs_input waits on a verdict; queued carries a
			// recorded verdict and waits on a slot — both still
			// own their parked call, so recovery watches them.
			const parked =
				row !== null &&
				(row.status === "needs_input" || row.status === "queued") &&
				row.pendingApproval !== null;
			if (row === null || row.stopRequested || (row.status !== "running" && !parked)) {
				recoveryAttempts.delete(id);
				continue;
			}
			const rec = recoveryAttempts.get(id);
			attempts = (rec?.count ?? 0) + 1;
			lastError = rec?.lastError ?? "";
			recoveryAttempts.set(id, { count: attempts, lastError });
			if (attempts > RECOVERY_MAX_ATTEMPTS) {
				exhausted = true;
			} else if (parked) {
				await recoverParked(deps, id);
				scheduleDrain();
				const after = runs.get(id);
				if (
					after === null ||
					after.stopRequested ||
					(after.status !== "needs_input" && after.status !== "queued") ||
					after.pendingApproval === null
				) {
					recoveryAttempts.delete(id);
				}
			} else {
				await recoverRun(deps, row);
				const after = runs.get(id);
				if (after === null || after.status !== "running" || after.stopRequested) {
					recoveryAttempts.delete(id);
				}
			}
		} catch (err) {
			// One lost cycle — counted once whether the failure
			// landed before or after this scan's own increment.
			if (attempts === 0) {
				attempts = (recoveryAttempts.get(id)?.count ?? 0) + 1;
			}
			const msg = err instanceof Error ? err.message : String(err);
			recoveryAttempts.set(id, { count: attempts, lastError: msg });
			if (attempts < RECOVERY_MAX_ATTEMPTS) {
				recoveryPending.add(id);
				log.error("subagent recovery retry failed — stays pending", err, {
					run: id,
					attempt: attempts,
					maxAttempts: RECOVERY_MAX_ATTEMPTS,
				});
				continue;
			}
			await exhaustRecovery(deps, id, attempts, msg, err);
			continue;
		}
		if (exhausted) {
			await exhaustRecovery(deps, id, attempts, lastError, undefined);
		}
	}
}
