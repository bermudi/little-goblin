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
const ADMIT_MAX_ATTEMPTS = 5;
const ADMIT_RETRY_BASE_MS = 5_000;

export interface AdmissionDeps {
	runs: SubagentRuns;
	desktops: Desktops;
	access: RowAccess;
	harnessBundle: () => HarnessBundle;
	refFor: (kind: SubagentKind) => KindSpec;
	importFiles: (row: SubagentRun) => Promise<string[]>;
	monitor: (rowId: number, rev: number, submission: Submission) => void;
	monitored: (rowId: number) => boolean;
	gate: ApprovalGate;
	releaseLeases: (row: SubagentRun) => void;
	notify: (row: SubagentRun) => void;
	scheduleDrain: () => void;
	recoveryPending: Set<number>;
	recoveryAttempts: Map<number, { count: number; lastError: string }>;
	retryAfter: Map<number, number>;
	admitAttempts: Map<number, number>;
	admitRetryMs: number | undefined;
	isClosing: () => boolean;
	isResumed: () => boolean;
	isHarnessClosed: () => boolean;
}

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
			if (fresh.piConversationId === null) {
				throw new SubagentError("queued approval run has no Pi conversation — corrupt park");
			}
			const d = fresh.pendingApproval.decision;
			if (d === undefined) {
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
				gate.storeDecision(key, d);
			}
			// The watcher must attach before the waiter resolves or the
			// scheduler runs — a restart-registered waiter rode a recovery
			// that attached none, and an unwatched settle leaks its slot.
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
		// Persist the intent before submit: a crash in between re-submits
		// the same requestId and gets the admitted submission back.
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
		const cur = runs.get(row.id);
		if (
			cur === null ||
			cur.stopRequested ||
			(cur.status !== "queued" && cur.status !== "running")
		) {
			return { kind: "halted" };
		}
		if (preserveRunning || cur.piConversationId !== null) {
			// A recorded conversation means a submission may have landed before
			// the error — even a thrown submit can be a lost ack. Keep the row
			// running and owned; scan recovery drives the idempotent re-admit.
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
		// No Pi conversation recorded, so no submission can have landed —
		// queued retry with backoff is safe here.
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
