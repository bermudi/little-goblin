// The subagent runtime (design/subagents.md): two purpose-typed runs —
// worker (coding tools over the origin conversation's sandbox) and
// computer (the desktop pool's observation/input surface). Only this
// directory imports Pi Durable, pi-ai and chord (the herdr.ts rule):
// harness, registry, extensions and env adapter live in its satellites,
// while monitors, queue admission and close live here; goblin rows in
// subagent-runs.ts hold routing so a restart is pause-and-resume, never
// kill.
//
// Crash gaps are the design's load-bearing detail: every input text is
// persisted with its revision AND mode before admit (the deterministic
// `subagent:<id>:input:<rev>` requestId makes a re-submit return the
// same admitted submission); terminal outcomes are committed to the
// per-run Pi document inside the tool call BEFORE control returns —
// settled submissions are classified from the doc, never from prose;
// stop's intent is persisted before the abort lands so a late
// settlement or a mid-admission step can never overwrite it. Input is
// replay-unsafe; only observation and the terminal writes are
// replay:"safe".

import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type CredentialStore,
	createModels,
	createProvider,
	envApiKeyAuth,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { type Submission } from "@earendil-works/pi-durable";
import type { AuthStore } from "../auth.ts";
import { exportNamedBytes } from "../box-files.ts";
import type { SubagentsConfig } from "../config.ts";
import { DesktopError, DesktopLeaseError, type Desktops } from "../desktops.ts";
import { log } from "../log.ts";
import { PodmanError } from "../podman.ts";
import { SandboxError, type Sandboxes } from "../sandboxes.ts";
import { subagentNotice } from "../subagent-prompts.ts";
import {
	approvalDecisionInputSchema,
	crashDecisionNotice,
	MAX_INPUT_FILES,
	MAX_MESSAGE_CHARS,
	MAX_TASK_CHARS,
	type PendingApproval,
	type SubagentApprovalDecision,
	type SubagentApprovalInput,
	type SubagentCrashDecision,
	type SubagentKind,
	type SubagentRun,
	type SubagentRuns,
} from "../subagent-runs.ts";

import { makeAdmission } from "./admission.ts";
import { makeApprovalGate } from "./approval-gate.ts";
import { makeDrain } from "./drain.ts";
import { SandboxEnv } from "./env.ts";
import { SubagentError } from "./errors.ts";
import { type KindSpec, kindSpec, type SubagentModelProfile } from "./models.ts";
import { makeRowAccess } from "./row-access.ts";
import { RunDoc } from "./run-doc.ts";
import { buildHarness } from "./tools.ts";
import { buildTransfer } from "./transfer.ts";

export { SubagentError };

const ctx: Context = BACKGROUND_CONTEXT;
const SCAN_MS = 30_000;

// Recovery (re-attaching a dead monitor) retries once per scan; past
// this many consecutive failures the run settles failed — no lifecycle
// path may hold its slot and lease forever.
const RECOVERY_MAX_ATTEMPTS = 10;

// ---------- the crash-approval lease ----------

// The lease and gate live in approval-gate.ts (design/subagents.md →
// Owner decomposition): a task-scoped pi-durable doc decides whether a
// replayed side-effecting call may run again — the correctness
// boundary, moved verbatim. The type re-export and approvalLeaseDoc
// stay here — crash tests and the public surface import them from
// mod.ts.
export type { SubagentApprovalDecision } from "../subagent-runs.ts";
export { approvalLeaseDoc } from "./approval-gate.ts";

// ---------- public surface ----------

export interface SubagentsDeps {
	config: SubagentsConfig;
	runs: SubagentRuns;
	auth: Pick<AuthStore, "resolve">;
	sandboxes: Sandboxes;
	desktops: Desktops;
	/** Pi Durable storage file — state/subagents.sqlite. */
	storagePath: string;
	/** Host-side staging dir for file imports (never model-addressed). */
	transferRoot: string;
	/** Wake the exact origin conversation — returns false to retry. */
	wake(conversationId: string, text: string): boolean;
	/** Opt-in experiment seam: per-kind explicit model profile. Absent
	 *  per kind, the pinned GLM catalog policy applies unchanged. */
	modelProfiles?: Partial<Record<SubagentKind, SubagentModelProfile>>;
	/** Opt-in experiment seam: extra Pi Durable settings, merged over
	 *  our defaults (tests shrink compaction windows or disable retry
	 *  backoff; production passes nothing). */
	harnessSettings?: Record<string, unknown>;
	/** Test seam: base delay (ms) for admission-retry backoff, doubled
	 *  per attempt. Production default 5s. */
	admitRetryMs?: number;
}

export interface SubagentStart {
	kind: SubagentKind;
	conversationId: string;
	workspace: string;
	task: string;
	desktop?: string;
	files?: string[];
}

export interface Subagents {
	start(input: SubagentStart, requestId?: string): Promise<SubagentRun>;
	list(conversationId: string): SubagentRun[];
	status(id: number, conversationId: string): SubagentRun | null;
	send(id: number, conversationId: string, message: string): Promise<SubagentRun>;
	stop(id: number, conversationId: string): Promise<SubagentRun>;
	/** Goblin's verdict on a run parked by the crash-approval gate —
	 *  stamps the provenance constants, persists the decision and the
	 *  crash-history record in one row write, and queues the
	 *  continuation for scheduler admission (a global slot plus
	 *  resource checks); the grant resolves the parked tool task. Only
	 *  valid on a `needs_input` row carrying `pendingApproval`. */
	decide(id: number, conversationId: string, decision: SubagentApprovalInput): Promise<SubagentRun>;
	/** Retry pending notices and stops, then drain the queue — the
	 *  scan timer calls. */
	scan(): Promise<void>;
	/** Ordered boot: finish persisted stops, reacquire desktops, attach
	 *  monitors and re-admit pending intents BEFORE any scheduling or
	 *  drain can run. Phase C settle wakes may already deliver to the
	 *  origin conversation — they ride the origin's own admission, not
	 *  the harness scheduler. Call once after every dep is bound. */
	resume(): Promise<void>;
	/** Pause admission and the ticker, join in-flight operations, then
	 *  close the harness — pending runs persist; nothing is aborted on
	 *  shutdown. */
	close(): Promise<void>;
}

export async function openSubagents(deps: SubagentsDeps): Promise<Subagents> {
	const config = deps.config;
	const runs = deps.runs;

	// ---------- providers (recipe: catalog model, per-kind provider,
	// credential in-process through goblin's auth) ----------
	const credentials: CredentialStore = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const kinds = (["worker", "computer"] as const).filter((k) => config[k] !== undefined);
	const specs = new Map<SubagentKind, KindSpec>();
	for (const kind of kinds) {
		const spec = kindSpec(config, kind, deps.modelProfiles?.[kind]);
		specs.set(kind, spec);
		const modelCfg = config[kind]!.model;
		const provider = createProvider<"openai-completions">({
			id: spec.providerId,
			name: `Goblin ${kind}`,
			baseUrl: modelCfg.baseUrl,
			auth: { apiKey: envApiKeyAuth("Goblin subagent credential", []) },
			models: [{ ...spec.catalog, provider: spec.providerId, baseUrl: modelCfg.baseUrl }],
			api: openAICompletionsApi(),
		});
		models.setProvider(provider);
		await credentials.modify(spec.providerId, async () => ({
			type: "api_key",
			key: await deps.auth.resolve(modelCfg.auth),
		}));
	}
	const refFor = (kind: SubagentKind) => {
		const spec = specs.get(kind);
		if (spec === undefined) throw new SubagentError(`subagents.${kind} is not configured`);
		return spec;
	};

	// ---------- owner state ----------

	let closing = false;
	let resumed = false;
	let harnessClosed = false;
	// All run-mutating operations serialize on the run's lane.
	const lanes = new Map<number, Promise<void>>();
	function lane<T>(id: number, fn: () => Promise<T>): Promise<T> {
		const prev = lanes.get(id) ?? Promise.resolve();
		const run = prev.then(fn, fn);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		tail.finally(() => {
			if (lanes.get(id) === tail) lanes.delete(id);
		});
		lanes.set(id, tail);
		return run;
	}
	// Rows mid-admission or mid-abort — they hold a global slot.
	// (The inflight set lives in drain.ts, the cluster's only consumer.)
	// Lease-conflicted rows retry no sooner than this — a blocked
	// desktop never spins the drain loop.
	const retryAfter = new Map<number, number>();
	// Consecutive transient admission failures per run — past the bound
	// the run settles terminal instead of re-queueing again.
	const admitAttempts = new Map<number, number>();

	// ---------- queue admission ----------

	// lane is a hoisted declaration below and admission binds after
	// the harness, so admit rides a lazy arrow; the flag getters
	// resolve lazily so the drain reads live closing/harnessClosed/
	// resumed. Constructed early — the approval gate's deps take
	// scheduleDrain by value.
	const { scheduleDrain, drain } = makeDrain({
		runs,
		desktops: deps.desktops,
		maxRuns: config.maxRuns,
		lane,
		admit: (row) => admission.admit(row),
		retryAfter,
		halted: () => closing || harnessClosed,
		isResumed: () => resumed,
	});
	// In-flight monitors and admissions — close joins them so a paused
	// run is left durable, never mutated after close. runMonitors tracks
	// WHICH runs still have a watcher: admission's approval-continuation
	// branch must not resolve a waiter that nobody is watching.
	const monitorTasks = new Set<Promise<void>>();
	const runMonitors = new Map<number, Set<Promise<void>>>();
	const recoveryPending = new Set<number>();
	// Consecutive recovery cycles per run that have not yet re-attached
	// settlement — recovery is the only thing that re-attaches it, so
	// past the bound the run settles failed and frees its slot instead
	// of hanging forever. lastError keeps the newest failure text for
	// the terminal notice.
	const recoveryAttempts = new Map<number, { count: number; lastError: string }>();

	// ---------- the run row behind a Pi conversation ----------

	const access = makeRowAccess({
		runs,
		isClosing: () => closing,
		isHarnessClosed: () => harnessClosed,
	});
	const {
		rowForConversation,
		requireRow,
		requireLive,
		recordOutcome,
		asConv,
		asSub,
		holderFor,
		persistClaimNote,
		throwIfHalted,
	} = access;

	const envs = new Map<string, SandboxEnv>();
	function envFor(origin: string): SandboxEnv {
		let env = envs.get(origin);
		if (env === undefined) {
			env = new SandboxEnv(deps.sandboxes, deps.transferRoot, origin);
			envs.set(origin, env);
		}
		return env;
	}

	// ---------- the crash-approval gate ----------

	// The failed-park abort is the owner's dep: the harness binds only
	// at buildHarness below, so the gate reaches it through this closure
	// resolved at call time.
	const gate = makeApprovalGate({
		runs,
		rowForConversation,
		recordOutcome,
		notify,
		releaseLeases,
		scheduleDrain,
		abortConversation: async (row) => {
			if (row.piConversationId === null || harnessClosed) return;
			try {
				const conv = await harness.conversation(asConv(row.piConversationId), ctx);
				// No waitForIdle here — this task IS the work being
				// aborted; the throw below ends it and the scan's stop
				// retry finishes the mark.
				void conv?.abort(ctx, { background: true }).catch((e) => {
					log.warn("abort after a failed park could not be fired", e, { run: row.id });
				});
			} catch (e) {
				log.warn("the failed-park abort could not be reached", e, { run: row.id });
			}
		},
	});

	// Re-drive input after a transient claim failure aborted a request.
	// It is goblin-voiced, not operator-voiced: the real input is already
	// a transcript entry, so the nudge only asks the run to continue.
	const RECOVERY_NUDGE =
		"[goblin] The previous model request aborted on transient infrastructure — your input is already in the transcript; continue the task.";

	// The request guard's transient desktop-claim path, owned here so the
	// hook never reaches into owner state: persist the nudge intent at a
	// fresh rev and mark the row recovery-pending. Cancellation may hold
	// the lane while joining the hook — cancel only the waiter, not the
	// lane operation; it must still serialize behind any provisional
	// steer.
	async function recoveryNudge(rowId: number, inputRev: number, context: Context): Promise<void> {
		await awaitWithContext(
			lane(rowId, async () => {
				const cur = runs.get(rowId);
				if (
					context.abortSignal?.aborted ||
					cur === null ||
					cur.status !== "running" ||
					cur.stopRequested
				)
					return;
				if (cur.inputIntent === null && cur.inputRev === inputRev) {
					runs.update(rowId, {
						inputRev: cur.inputRev + 1,
						inputIntent: RECOVERY_NUDGE,
						inputMode: null,
					});
				}
				recoveryPending.add(rowId);
			}),
			context,
		);
	}

	// ---------- harness and tool assembly ----------

	const { harness, workerExtension, computerExtension } = await buildHarness({
		deps,
		runs,
		specs,
		models,
		withApprovalGate: gate.withGate,
		ctx,
		holderFor,
		rowForConversation,
		requireRow,
		requireLive,
		recordOutcome,
		envFor,
		persistClaimNote,
		recoveryNudge,
	});
	// The Session's real close edge — only this pauses admission for a
	// dead harness; durable rows still recover on the next boot.
	harness.subscribeClose(() => {
		harnessClosed = true;
	});

	// ---------- files in/out ----------

	const { importFiles, exportOutcomeFiles } = buildTransfer({
		transferRoot: deps.transferRoot,
		sandboxes: deps.sandboxes,
		desktops: deps.desktops,
		runs,
		throwIfHalted,
		halted: () => closing || harnessClosed,
	});

	// ---------- notices ----------

	// One deterministic body per row state — the first delivery and
	// every retry carry the same fenced content: result, exported
	// paths, export refusals and the final screenshot all live inside
	// the event fence; only id/kind/status sit outside it.
	function noticeBody(row: SubagentRun): string {
		let body = noticeResult(row);
		if (row.lifecycleNote !== null) body += `\nLifecycle warning: ${row.lifecycleNote}`;
		const crash = crashDecisionNotice(row.crashDecisions);
		if (crash !== null) body += `\n${crash}`;
		return body;
	}

	function noticeResult(row: SubagentRun): string {
		switch (row.status) {
			case "needs_input":
				return row.pendingApproval !== null
					? `Crash resolution needed — a restarted ${row.pendingApproval.tool} call may have partially run:\n${row.question ?? ""}`
					: `Question: ${row.question ?? ""}`;
			case "stopped":
				return "Stopped by the originating conversation.";
			case "failed":
				return row.error ?? "run failed";
			case "done": {
				let b = row.result ?? "";
				if (row.exportedFiles.length > 0) b += `\nExported: ${row.exportedFiles.join(", ")}`;
				if (row.exportErrors.length > 0) b += `\nExport refused: ${row.exportErrors.join("; ")}`;
				if (row.finalScreenshot !== null) b += `\nFinal screenshot: ${row.finalScreenshot}`;
				return b;
			}
			default:
				return `status: ${row.status}`;
		}
	}

	function notify(row: SubagentRun): void {
		if (closing || harnessClosed) return;
		const rev = row.noticeRev + 1;
		const fresh = runs.update(row.id, { noticeRev: rev, noticePending: true });
		let ok = false;
		try {
			ok = deps.wake(
				fresh.conversationId,
				subagentNotice(fresh.id, fresh.kind, fresh.status, noticeBody(fresh)),
			);
		} catch (err) {
			log.warn("subagent wake threw — notice stays pending", err, { run: fresh.id });
		}
		if (ok) {
			// CAS: a reentrant send may have bumped the notice while the
			// wake was in flight — only this rev's ack may clear it.
			runs.ackNotice(fresh.id, rev);
		} else {
			log.warn("subagent notice not admitted — will retry on scan", { run: fresh.id });
		}
		log.info("subagent notice", { run: fresh.id, status: fresh.status, woke: ok });
	}

	function releaseLeases(row: SubagentRun): void {
		if (row.kind === "computer" && row.desktop !== null) {
			deps.desktops.release(row.desktop, holderFor(row.id)).catch((err) =>
				log.warn("desktop release on settle failed", err, {
					run: row.id,
					desktop: row.desktop,
				}),
			);
		}
	}

	// ---------- stop ----------

	// Stop persists the intent first (outside the lane so a mid-flight
	// admission sees it at its next boundary), then the abort joins
	// through the lane; the row is only marked stopped once the Pi side
	// is actually idle. An abort failure leaves the intent standing —
	// scan retries it; the slot stays held meanwhile.
	async function completeStop(id: number): Promise<void> {
		await lane(id, async () => {
			const row = runs.get(id);
			if (row === null || row.status === "stopped") return;
			if (row.piConversationId !== null) {
				// A closed harness can't confirm the abort — never claim
				// stopped while Pi work may still be live; the intent
				// stays persisted and the next boot finishes it.
				if (harnessClosed) {
					throw new SubagentError("harness closed — stop cannot be confirmed");
				}
				const conv = await harness.conversation(asConv(row.piConversationId), ctx);
				await conv?.abort(ctx, { background: true });
				await conv?.waitForIdle(ctx);
			}
			const stopped = runs.update(id, {
				status: "stopped",
				finishedAt: Date.now(),
				noticePending: true,
				pendingApproval: null,
			});
			if (row.piConversationId !== null) gate.dropForConversation(row.piConversationId);
			// A stopped row is never re-admitted — its retry budgets and
			// backoff entry are dead weight.
			admitAttempts.delete(id);
			retryAfter.delete(id);
			recoveryAttempts.delete(id);
			log.info("subagent stopped", { run: id, kind: stopped.kind });
			releaseLeases(stopped);
			notify(stopped);
		});
	}

	// Terminal settling past a recorded Pi conversation is only allowed
	// once the conversation is proven dead — the failed step may already
	// have landed a submission that is still executing. A missing
	// conversation IS the proof; a failed lookup/abort/join is not, so
	// callers get false and keep the row owned and recovery-pending
	// rather than releasing a slot Pi may still be burning.
	async function confirmPiIdle(rowId: number, piConversationId: string): Promise<boolean> {
		if (harnessClosed) return false;
		try {
			const conv = await harness.conversation(asConv(piConversationId), ctx);
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

	// ---------- settle / monitor ----------

	// The one finalizer per run — every path (submission settled,
	// recovery, unanswered input) funnels here inside the run's lane.
	// The committed doc outcome is the authority: an unanswered
	// submission with a recorded finish still completes as done.
	// A "done" submission ended on a clean provider stop — the last
	// assistant's recorded stopReason is the only remaining witness for
	// why no terminal tool ran (length = truncation, not a refusal).
	async function lastAssistantStopReason(piConversationId: string): Promise<string | null> {
		const conv = await harness.conversation(asConv(piConversationId), ctx);
		if (conv === undefined) return null;
		const page = await conv.entries({}, 8, undefined, ctx);
		for (const entry of page.items) {
			const last = entry.model?.findLast((m) => m.role === "assistant");
			if (last !== undefined) return last.stopReason ?? null;
		}
		return null;
	}

	async function finalize(
		rowId: number,
		rev: number,
		unanswered?: { reason: string; detail?: string | undefined },
	): Promise<void> {
		await lane(rowId, async () => {
			// A close landing anywhere past the first check leaves the
			// row recoverable `running`: the doc outcome and any landed
			// exportProgress are durable, the next boot's finalize
			// resumes from them — never a partial done/failed notice.
			const closingNow = () => closing || harnessClosed;
			// Stop intent lands outside the lane — after every awaited
			// step a fresh row read decides whether a terminal/question
			// transition is still this path's to make; once stop intent
			// is persisted the stop path owns them.
			const preempted = (): boolean => {
				if (closingNow()) return true;
				const cur = runs.get(rowId);
				return cur === null || cur.stopRequested || cur.status === "stopped";
			};
			const row = runs.get(rowId);
			if (row === null) return;
			if (row.status === "stopped" || row.status === "done" || row.status === "failed") return;
			if (row.stopRequested) return; // the stop path owns the transition
			if (row.inputRev > rev || row.inputIntent !== null) return; // a newer input owns settlement
			if (closingNow()) return;
			if (row.piConversationId === null) {
				if (preempted()) return;
				runs.update(rowId, {
					status: "failed",
					error: "no Pi conversation recorded",
					noticePending: true,
					finishedAt: Date.now(),
				});
				return;
			}
			// Pi commits are durable — after waitForIdle a single read is
			// authoritative; a storage error propagates to the caller.
			const doc = await harness.snapshot(RunDoc, asConv(row.piConversationId), ctx);
			if (preempted()) return;
			const recorded = doc?.outcome ?? null;
			// An outcome only settles the input it answered — a stale one
			// must never be attributed to a later submitted steer.
			const outcome = recorded !== null && recorded.rev === rev ? recorded : null;
			log.info("subagent settle", { run: rowId, outcome: outcome?.kind ?? null, unanswered });
			if (outcome?.kind === "done") {
				const { exported, errors } = await exportOutcomeFiles(row, outcome.files);
				if (preempted()) return; // a close or stop during export starts no new screenshot
				let finalScreenshot = row.finalScreenshot;
				if (row.kind === "computer" && row.desktop !== null && finalScreenshot === null) {
					try {
						const shot = await deps.desktops.screenshot(row.desktop);
						const out = exportNamedBytes(
							row.workspace,
							join("subagents", String(row.id)),
							"final.png",
							shot.bytes,
						);
						if ("error" in out) errors.push(`final screenshot: ${out.error}`);
						else {
							finalScreenshot = out.rel;
							runs.update(rowId, { finalScreenshot });
						}
					} catch (err) {
						// Same contract as file exports: a typed refusal is an
						// outcome; an unexpected host/storage error is a failed
						// settle that must not mark the run done.
						if (
							err instanceof DesktopError ||
							err instanceof SandboxError ||
							err instanceof PodmanError
						) {
							errors.push(`final screenshot: ${err.message}`);
						} else {
							throw err;
						}
					}
				}
				// Stop wins over a settlement that raced an export.
				if (preempted()) return;
				const done = runs.update(rowId, {
					status: "done",
					result: outcome.result,
					exportedFiles: exported,
					exportErrors: errors,
					noticePending: true,
					finishedAt: Date.now(),
				});
				releaseLeases(done);
				notify(done);
			} else if (outcome?.kind === "ask") {
				if (preempted()) return;
				const waiting = runs.update(rowId, {
					status: "needs_input",
					question: outcome.question,
					noticePending: true,
				});
				releaseLeases(waiting);
				notify(waiting);
			} else if (outcome?.kind === "aborted") {
				// The operator's abandon verdict, recorded by the gate.
				if (preempted()) return;
				const failed = runs.update(rowId, {
					status: "failed",
					error: outcome.reason,
					noticePending: true,
					finishedAt: Date.now(),
				});
				releaseLeases(failed);
				notify(failed);
			} else {
				let error: string;
				if (unanswered !== undefined) {
					error = `input went unanswered: ${unanswered.reason}`;
					if (unanswered.detail !== undefined && unanswered.detail.length > 0)
						error += ` — ${unanswered.detail}`;
				} else {
					const lastStop = await lastAssistantStopReason(row.piConversationId);
					if (preempted()) return;
					error =
						lastStop === "length"
							? "the model's reply hit the output limit (stop reason length) before any terminal tool call"
							: lastStop !== null && lastStop !== "stop"
								? `the run ended on stop reason ${lastStop} without a terminal tool call`
								: "the run settled without a terminal tool call — plain prose is never a completion";
				}
				const failed = runs.update(rowId, {
					status: "failed",
					error,
					noticePending: true,
					finishedAt: Date.now(),
				});
				releaseLeases(failed);
				notify(failed);
			}
		});
	}

	function monitor(rowId: number, rev: number, submission: Submission): void {
		const task = (async () => {
			try {
				const settled = await submission.wait(ctx);
				if (closing || harnessClosed) return;
				// submission.wait resolves on the answer entry; the
				// terminal tool's doc commit lands with the round — idle
				// first so a recorded finish is never read as "no outcome".
				const row = runs.get(rowId);
				if (row?.piConversationId != null) {
					const conv = await harness.conversation(asConv(row.piConversationId), ctx);
					await conv?.waitForIdle(ctx);
				}
				await finalize(
					rowId,
					rev,
					settled.status === "unanswered"
						? {
								reason: settled.reason ?? "unknown",
								detail:
									settled.detail === undefined
										? undefined
										: typeof settled.detail === "string"
											? settled.detail
											: JSON.stringify(settled.detail),
							}
						: undefined,
				);
				// A monitor that observed its submission through is the
				// only real recovery — this, not recoverRun returning,
				// is what clears the retry count.
				recoveryAttempts.delete(rowId);
			} catch (err) {
				if (closing || harnessClosed) return;
				log.error("subagent monitor failed — the run stays owned for recovery", err, {
					run: rowId,
				});
				// The wait's failure is the freshest evidence for an
				// eventual exhaustion notice; the attempt count itself
				// belongs to the scan.
				recoveryAttempts.set(rowId, {
					count: recoveryAttempts.get(rowId)?.count ?? 0,
					lastError: err instanceof Error ? err.message : String(err),
				});
				recoveryPending.add(rowId);
			} finally {
				scheduleDrain();
			}
		})();
		monitorTasks.add(task);
		const watching = runMonitors.get(rowId) ?? new Set<Promise<void>>();
		watching.add(task);
		runMonitors.set(rowId, watching);
		void task.finally(() => {
			monitorTasks.delete(task);
			watching.delete(task);
			if (watching.size === 0) runMonitors.delete(rowId);
		});
	}

	// Is a settlement watcher still live for this run? A monitor's task
	// stays counted through its finalize, so "watched" means somebody
	// observes the current submission's settle — the fact admission's
	// approval branch needs.
	function monitored(rowId: number): boolean {
		return (runMonitors.get(rowId)?.size ?? 0) > 0;
	}

	// ---------- admission ----------

	// monitor/monitored are hoisted declarations above; the harness
	// bundle resolves per admit — it binds only at buildHarness.
	const admission = makeAdmission({
		runs,
		desktops: deps.desktops,
		access,
		harnessBundle: () => ({ harness, workerExtension, computerExtension }),
		refFor,
		importFiles,
		monitor,
		monitored,
		gate,
		releaseLeases,
		notify,
		scheduleDrain,
		recoveryPending,
		recoveryAttempts,
		retryAfter,
		admitAttempts,
		admitRetryMs: deps.admitRetryMs,
		isClosing: () => closing,
		isResumed: () => resumed,
		isHarnessClosed: () => harnessClosed,
	});
	async function recoverRun(boot: SubagentRun): Promise<void> {
		const rev = await lane(boot.id, async (): Promise<number | undefined> => {
			const live = (): SubagentRun | null => {
				if (closing || harnessClosed) return null;
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
	async function recoverParked(id: number): Promise<void> {
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
		id: number,
		attempts: number,
		msg: string,
		err: unknown,
	): Promise<void> {
		const settled = await lane(id, async (): Promise<boolean> => {
			if (closing || harnessClosed) return false;
			const live = runs.get(id);
			const parked =
				live !== null &&
				(live.status === "needs_input" || live.status === "queued") &&
				live.pendingApproval !== null;
			if (live === null || live.stopRequested || (live.status !== "running" && !parked)) {
				return true;
			}
			if (live.piConversationId !== null && !(await confirmPiIdle(id, live.piConversationId))) {
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
			if (closing || harnessClosed) {
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

	// ---------- the owner ----------

	const ticker = { id: null as ReturnType<typeof setInterval> | null };

	const owner: Subagents = {
		async start(input, requestId) {
			if (closing) throw new SubagentError("subagents are closed");
			const kind = input.kind;
			refFor(kind); // unconfigured type refuses loudly
			if (input.task.length === 0 || input.task.length > MAX_TASK_CHARS) {
				throw new SubagentError(`task must be 1..${MAX_TASK_CHARS} chars`);
			}
			if ((input.files?.length ?? 0) > MAX_INPUT_FILES) {
				throw new SubagentError(`at most ${MAX_INPUT_FILES} files`);
			}
			if (kind === "computer" && input.desktop === undefined) {
				throw new SubagentError("computer runs need a desktop name");
			}
			if (requestId !== undefined) {
				const existing = runs.listFor(input.conversationId).find((r) => r.requestId === requestId);
				if (existing !== undefined) return existing;
			}
			const row = runs.create({
				kind,
				conversationId: input.conversationId,
				workspace: input.workspace,
				desktop: input.desktop ?? null,
				task: input.task,
				files: input.files ?? [],
				requestId: requestId ?? null,
			});
			log.info("subagent queued", {
				run: row.id,
				kind,
				conversation: input.conversationId,
				desktop: input.desktop,
			});
			scheduleDrain();
			return row;
		},
		list: (conv) => runs.listFor(conv),
		status(id, conv) {
			const row = runs.get(id);
			return row !== null && row.conversationId === conv ? row : null;
		},
		async send(id, conv, message) {
			if (closing) throw new SubagentError("subagents are closed");
			if (message.length === 0 || message.length > MAX_MESSAGE_CHARS) {
				throw new SubagentError(`message must be 1..${MAX_MESSAGE_CHARS} chars`);
			}
			return await lane(id, async () => {
				const row = runs.get(id);
				if (row === null || row.conversationId !== conv) {
					throw new SubagentError(`no subagent run #${id} in this conversation`);
				}
				if (row.stopRequested) {
					throw new SubagentError(`run #${id} is stopping`);
				}
				if (row.status !== "running" && row.status !== "needs_input") {
					throw new SubagentError(
						`run #${id} is ${row.status} — send needs running or needs_input`,
					);
				}
				if (row.pendingApproval !== null) {
					// A parked approval is not a question the model may
					// answer — a queued/steered message would sit behind a
					// tool task that only a decide verdict resolves.
					throw new SubagentError(
						`run #${id} awaits an approval decision on an interrupted ${row.pendingApproval.tool} call — use decide`,
					);
				}
				if (row.piConversationId === null) {
					throw new SubagentError(`run #${id} has not been admitted yet`);
				}
				const rev = row.inputRev + 1;
				if (row.status === "needs_input") {
					// Requeue through the scheduler — the answer waits for a
					// global slot like any other work; the sandbox lease stays.
					runs.update(id, {
						inputRev: rev,
						inputIntent: message,
						inputMode: "resume",
						status: "queued",
					});
					log.info("subagent input queued", { run: id, rev });
					scheduleDrain();
					return runs.get(id)!;
				}
				// A persisted intent is the retry path's authority —
				// overwriting its revision would break the deterministic
				// requestId of a submission that may already have landed.
				if (row.inputIntent !== null) {
					throw new SubagentError(
						`run #${id} has a persisted input still retrying — it owns the next submission`,
					);
				}
				// Steering a live run: persist the intent, then admit
				// through the same lane so a crash at any gap recovers it.
				const origRev = row.inputRev;
				runs.update(id, {
					inputRev: rev,
					inputIntent: message,
					inputMode: "steer",
				});
				const outcome = await admission.admit(runs.get(id)!, true);
				if (outcome.kind === "halted") {
					throw new SubagentError(`run #${id} was stopped mid-send`);
				}
				if (outcome.kind === "blocked") {
					// Blocked means the claim refused before any submit —
					// this revision was never admitted, so rolling back
					// reuses no deterministic requestId, and the original
					// monitor still owns settlement of the in-flight input.
					runs.update(id, { inputRev: origRev, inputIntent: null, inputMode: null });
					throw new SubagentError(`run #${id} cannot be steered — ${outcome.reason}`);
				}
				if (outcome.kind === "requeued") {
					// Past the claim, the admission may already have placed a
					// submission — rolling back could orphan it. The intent
					// stays persisted; the drain retries the idempotent path.
					throw new SubagentError(
						`run #${id} could not be steered — ${outcome.reason}; the steer stays persisted and retries`,
					);
				}
				return runs.get(id)!;
			});
		},
		async stop(id, conv) {
			if (closing) throw new SubagentError("subagents are closed");
			const row = runs.get(id);
			if (row === null || row.conversationId !== conv) {
				throw new SubagentError(`no subagent run #${id} in this conversation`);
			}
			if (row.status === "done" || row.status === "failed") return row;
			if (row.status === "stopped") return row;
			// The intent lands outside the lane: a mid-admission step or
			// a replayed tool sees it at its next boundary, before the
			// abort could even be queued.
			runs.update(id, { stopRequested: true });
			log.info("subagent stop requested", { run: id, kind: row.kind });
			try {
				await completeStop(id);
			} catch (err) {
				// Retryable — the intent stands and scan reattempts; the
				// row is NOT claimed stopped while Pi work may still run.
				log.warn("subagent abort failed — stop stays pending", err, { run: id });
			}
			return runs.get(id)!;
		},
		async decide(id, conv, decision) {
			if (closing) throw new SubagentError("subagents are closed");
			const parsed = approvalDecisionInputSchema.safeParse(decision);
			if (!parsed.success) {
				throw new SubagentError(`invalid approval decision: ${parsed.error.message}`);
			}
			const d: SubagentApprovalDecision = {
				...parsed.data,
				decidedBy: "goblin",
				outcome: "unverified",
			};
			return await lane(id, async () => {
				const row = runs.get(id);
				if (row === null || row.conversationId !== conv) {
					throw new SubagentError(`no subagent run #${id} in this conversation`);
				}
				if (row.stopRequested) {
					throw new SubagentError(`run #${id} is stopping`);
				}
				if (row.status !== "needs_input" || row.pendingApproval === null) {
					throw new SubagentError(`run #${id} is not parked on an approval decision`);
				}
				if (row.piConversationId === null) {
					throw new SubagentError(`run #${id} has no Pi conversation — corrupt park`);
				}
				const pending = row.pendingApproval;
				// The verdict lands ON the parked mirror — durable across a
				// crash in the grant window — and the row queues for a
				// global slot: the drain's admit() runs the same capacity
				// and resource checks every resumed row passes before
				// model work may continue. Marking running directly would
				// let a parked run jump the queue while another run holds
				// the only slot.
				const record: SubagentCrashDecision = {
					piTaskId: pending.piTaskId,
					callId: pending.callId,
					tool: pending.tool,
					args: pending.args,
					attempts: pending.attempts,
					decidedAt: Date.now(),
					decision: d,
				};
				const updated = runs.update(id, {
					status: "queued",
					pendingApproval: { ...pending, decision: d },
					crashDecisions: [...row.crashDecisions, record],
				});
				log.info("subagent approval decided — queued for admission", {
					run: id,
					piTaskId: pending.piTaskId,
					tool: pending.tool,
					callId: pending.callId,
					kind: d.kind,
					decidedBy: d.decidedBy,
					outcome: d.outcome,
					attempts: pending.attempts,
					evidenceChars: d.evidence?.length ?? 0,
					reasoningChars: d.reasoning?.length ?? 0,
				});
				scheduleDrain();
				return updated;
			});
		},
		async scan() {
			if (closing) throw new SubagentError("subagents are closed");
			for (const row of runs.pendingStops()) {
				try {
					await completeStop(row.id);
				} catch (err) {
					log.warn("subagent stop retry failed", err, { run: row.id });
				}
			}
			for (const row of runs.pendingNotices()) {
				notify(row);
			}
			for (const id of [...recoveryPending]) {
				if (closing || harnessClosed) break;
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
					// Every pickup spends one bounded attempt. A recoverRun
					// that returns is only provisional — it may have merely
					// attached a replacement monitor or re-parked a blocked
					// readmit — so the count clears on observed settlement
					// (a monitor completing, or the row leaving running),
					// never on the attempt's return alone.
					const rec = recoveryAttempts.get(id);
					attempts = (rec?.count ?? 0) + 1;
					lastError = rec?.lastError ?? "";
					recoveryAttempts.set(id, { count: attempts, lastError });
					if (attempts > RECOVERY_MAX_ATTEMPTS) {
						exhausted = true;
					} else if (parked) {
						await recoverParked(id);
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
						await recoverRun(row);
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
					await exhaustRecovery(id, attempts, msg, err);
					continue;
				}
				if (exhausted) {
					await exhaustRecovery(id, attempts, lastError, undefined);
				}
			}
			await drain();
		},
		async resume() {
			if (closing) throw new SubagentError("subagents are closed");
			if (resumed) return;
			// Phase A — row decisions only, before ANY call that could
			// enable Pi's scheduler (wait/abort submit progress).
			// A lowered maxRuns never silently exceeds: fail loudly.
			const running = runs.unfinished().filter((r) => r.status === "running");
			if (running.length > config.maxRuns) {
				resumed = false;
				throw new SubagentError(
					`${running.length} runs are executing but subagents.maxRuns is ${config.maxRuns} — raise the cap or stop runs`,
				);
			}
			// Verify/reacquire desktop controllers first: a lost lease
			// fails the run loudly — its pending Pi work is aborted in
			// phase B, it gets no monitor and no further input.
			const leaseFailedConvs: string[] = [];
			for (const row of running) {
				if (row.kind !== "computer" || row.desktop === null) continue;
				try {
					const claimed = await deps.desktops.claim(row.desktop, holderFor(row.id));
					persistClaimNote(row.id, claimed.note);
				} catch (err) {
					if (!(err instanceof DesktopLeaseError)) {
						log.error("desktop boot reconciliation failed — run retained for recovery", err, {
							run: row.id,
							desktop: row.desktop,
						});
						throw err;
					}
					const msg = err instanceof Error ? err.message : String(err);
					const failed = runs.update(row.id, {
						status: "failed",
						error: `desktop ${row.desktop} is no longer held by this run: ${msg}`,
						noticePending: true,
						finishedAt: Date.now(),
					});
					releaseLeases(failed);
					if (row.piConversationId !== null) leaseFailedConvs.push(row.piConversationId);
					log.warn("computer run lost its desktop lease at boot — failed", err, {
						run: row.id,
						desktop: row.desktop,
					});
				}
			}
			const pendingStopRows = runs.pendingStops();
			// A row tagged stopped by an older process can still have
			// live Pi work (its abort never joined) — collect it now.
			const live = await harness.inspect(ctx);
			const liveConvs = new Set<string>();
			for (const s of live.submissions) liveConvs.add(String(s.conversationId));
			for (const t of live.tasks) {
				if (t.record.conversationId !== undefined) {
					liveConvs.add(String(t.record.conversationId));
				}
			}
			const cancelConvs = new Set(leaseFailedConvs);
			for (const convId of liveConvs) {
				const row = runs.byPiConversation(convId);
				if (
					row === null ||
					row.stopRequested ||
					["done", "failed", "stopped"].includes(row.status)
				) {
					cancelConvs.add(convId);
				}
			}
			// abort()/waitForIdle() enable Pi's scheduler. Durably mark ALL
			// forbidden tasks first, including already-checkpointed compactions
			// that bypass the generation request hook.
			for (const task of live.tasks) {
				if (
					task.record.conversationId === undefined ||
					!cancelConvs.has(String(task.record.conversationId))
				)
					continue;
				// Unlike Conversation.abort, abortTask does not resume scheduling.
				await harness.abortTask(task.record.id, ctx);
			}
			// Phase B — aborts (each enables Pi's scheduler, so every
			// row decision above is already persisted).
			for (const convId of cancelConvs) {
				try {
					const conv = await harness.conversation(asConv(convId), ctx);
					await conv?.abort(ctx, { background: true });
				} catch (err) {
					log.error("subagent boot cancellation unconfirmed — refusing resume", err, {
						conversation: convId,
					});
					throw err;
				}
			}
			for (const row of pendingStopRows) {
				try {
					await completeStop(row.id);
				} catch (err) {
					log.error("subagent boot stop failed — refusing resume", err, { run: row.id });
					throw err;
				}
			}
			// Phase C — every unfinished row recovers its durable half.
			for (const row of runs.unfinished()) {
				if (row.stopRequested) continue; // step 1 owns it
				if (row.status === "queued") continue; // drain admits it
				if (row.status === "needs_input") {
					if (row.pendingApproval !== null) {
						// Approval park: the parked tool task re-enters the
						// gate under harness.resume() — attach the monitor
						// first so a decided run's settle is observed.
						try {
							await recoverParked(row.id);
						} catch (err) {
							log.error(
								"subagent parked-approval reattach failed — the row stays owned for a scan retry",
								err,
								{ run: row.id },
							);
							recoveryPending.add(row.id);
						}
						continue;
					}
					// A computer's controller was released at settle.
					releaseLeases(row);
					continue;
				}
				// running
				try {
					await recoverRun(row);
				} catch (err) {
					log.error("subagent recovery failed — the row stays owned for a scan retry", err, {
						run: row.id,
					});
					recoveryPending.add(row.id);
				}
			}
			// 5. Only now may scheduling and drains start. Phase C's
			// settle wakes already ran — a finalize delivering its
			// notice during recovery is the intended early signal, not
			// a breach of the ordering.
			resumed = true;
			harness.resume();
			ticker.id = setInterval(() => {
				void owner.scan().catch((err) => log.error("subagent scan failed", err));
			}, SCAN_MS);
			ticker.id.unref?.();
			scheduleDrain();
		},
		async close() {
			if (closing) return;
			closing = true;
			if (ticker.id !== null) clearInterval(ticker.id);
			// Join in-flight admissions and monitors — a paused
			// admission leaves the row queued with its intent
			// persisted, never a post-close failed/notify mutation.
			// Admissions first — sealing the harness settles the
			// submission waits the monitors sit on.
			await Promise.allSettled([...lanes.values()]);
			await harness.close(ctx);
			harnessClosed = true;
			for (;;) {
				const pending = [...lanes.values(), ...monitorTasks];
				if (pending.length === 0) break;
				await Promise.allSettled(pending);
			}
		},
	};
	return owner;
}
