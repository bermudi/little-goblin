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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
import { makeRecovery } from "./recovery.ts";
import { makeRowAccess } from "./row-access.ts";
import { RunDoc } from "./run-doc.ts";
import { makeSettle } from "./settle.ts";
import { buildHarness } from "./tools.ts";
import { buildTransfer } from "./transfer.ts";

export { SubagentError };

const ctx: Context = BACKGROUND_CONTEXT;
const SCAN_MS = 30_000;

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
	// In-flight monitors live in the settle unit — close joins them via
	// pendingMonitors() so a paused run is left durable, never mutated
	// after close.
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
		// settle binds below the gate — both callbacks resolve lazily.
		notify: (row) => settle.notify(row),
		releaseLeases: (row) => settle.releaseLeases(row),
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
		// recovery binds after the harness — the hook resolves lazily.
		recoveryNudge: (rowId, inputRev, context) => recovery.nudge(rowId, inputRev, context),
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

	// ---------- settle / notices ----------

	// The monitor task sets live inside the settle unit — close()
	// joins them through pendingMonitors().
	const settle = makeSettle({
		runs,
		lane,
		harness,
		access,
		desktops: deps.desktops,
		exportOutcomeFiles,
		wake: deps.wake,
		gate,
		scheduleDrain,
		admitAttempts,
		retryAfter,
		recoveryPending,
		recoveryAttempts,
		isClosing: () => closing,
		isHarnessClosed: () => harnessClosed,
	});
	// ---------- admission ----------

	// The settle unit binds just above; the harness bundle resolves per
	// admit — it binds only at buildHarness.
	const admission = makeAdmission({
		runs,
		desktops: deps.desktops,
		access,
		harnessBundle: () => ({ harness, workerExtension, computerExtension }),
		refFor,
		importFiles,
		monitor: settle.monitor,
		monitored: settle.monitored,
		gate,
		releaseLeases: settle.releaseLeases,
		notify: settle.notify,
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

	// ---------- recovery ----------

	// The settle unit binds above; admission is the unit just
	// constructed — recovery drives its re-admit path.
	const recovery = makeRecovery({
		runs,
		lane,
		harness,
		access,
		admission,
		monitor: settle.monitor,
		finalize: settle.finalize,
		gate,
		releaseLeases: settle.releaseLeases,
		notify: settle.notify,
		scheduleDrain,
		recoveryPending,
		recoveryAttempts,
		isClosing: () => closing,
		isHarnessClosed: () => harnessClosed,
	});

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
				await settle.completeStop(id);
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
					await settle.completeStop(row.id);
				} catch (err) {
					log.warn("subagent stop retry failed", err, { run: row.id });
				}
			}
			for (const row of runs.pendingNotices()) {
				settle.notify(row);
			}
			await recovery.drive();
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
					settle.releaseLeases(failed);
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
					await settle.completeStop(row.id);
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
							await recovery.recoverParked(row.id);
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
					settle.releaseLeases(row);
					continue;
				}
				// running
				try {
					await recovery.recoverRun(row);
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
				const pending = [...lanes.values(), ...settle.pendingMonitors()];
				if (pending.length === 0) break;
				await Promise.allSettled(pending);
			}
		},
	};
	return owner;
}
