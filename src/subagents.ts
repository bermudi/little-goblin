import { buildTools } from "./subagents/tools.ts";
import { join } from "node:path";
import { exportNamedBytes } from "./box-files.ts";
import { buildTransfer } from "./subagents/transfer.ts";
// The subagent runtime (design/subagents.md): two purpose-typed runs —
// worker (coding tools over the origin conversation's sandbox) and
// computer (the desktop pool's observation/input surface). This is the
// ONLY directory that imports Pi Durable / pi-ai / chord (the herdr.ts
// rule): harness, registry, extensions, env adapter, monitors, queue
// admission and close live here; goblin rows in subagent-runs.ts hold
// routing so a restart is pause-and-resume, never kill.
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

import { Buffer } from "node:buffer";
import type { Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type CredentialStore,
	createModels,
	createProvider,
	envApiKeyAuth,
	InMemoryCredentialStore,
	Type,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTool,
	GenerationTask,
	Harness,
	type HookApi,
	hook,
	type Submission,
	type SubmissionId,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
	ToolTask,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { z } from "zod";
import type { AuthStore } from "./auth.ts";
import type { SubagentsConfig } from "./config.ts";
import {
	CUA_TOOLS,
	type CuaTool,
	DesktopError,
	DesktopLeaseError,
	type Desktops,
	type LeaseHolder,
} from "./desktops.ts";
import { log } from "./log.ts";
import { PodmanError } from "./podman.ts";
import { SandboxError, type Sandboxes } from "./sandboxes.ts";
import {
	ASK_OPERATOR_TOOL_DESCRIPTION,
	COMPUTER_PROMPT,
	COMPUTER_TOOL_DESCRIPTIONS,
	FINISH_TOOL_DESCRIPTION,
	SUBAGENT_PARAMETER_DESCRIPTIONS,
	subagentNotice,
	subagentTaskInput,
	WORKER_BASH_DESCRIPTION,
	WORKER_PROMPT,
} from "./subagent-prompts.ts";
import {
	type InputMode,
	MAX_INPUT_FILES,
	MAX_MESSAGE_CHARS,
	MAX_RESULT_CHARS,
	MAX_TASK_CHARS,
	type SubagentKind,
	type SubagentRun,
	type SubagentRuns,
} from "./subagent-runs.ts";

import { SubagentError } from "./subagents/errors.ts";
export { SubagentError } from "./subagents/errors.ts";
import { SandboxEnv } from "./subagents/env.ts";
import { kindSpec, type KindSpec, type SubagentModelProfile } from "./subagents/models.ts";
export type { SubagentModelProfile } from "./subagents/models.ts";
import { RunDoc, type RunOutcome, type RunOutcomeBody } from "./subagents/run-doc.ts";

const ctx: Context = BACKGROUND_CONTEXT;
const SCAN_MS = 30_000;
const LEASE_RETRY_MS = 5_000;
// Transient admission failures re-queue the run with exponential
// backoff off this base; only the attempt bound settles it terminal.
const ADMIT_MAX_ATTEMPTS = 5;
const ADMIT_RETRY_BASE_MS = 5_000;
// Recovery (re-attaching a dead monitor) retries once per scan; past
// this many consecutive failures the run settles failed — no lifecycle
// path may hold its slot and lease forever.
const RECOVERY_MAX_ATTEMPTS = 10;

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
	const holderFor = (runId: number): LeaseHolder => ({ kind: "run", id: String(runId) });

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
	const inflight = new Set<number>();
	// Lease-conflicted rows retry no sooner than this — a blocked
	// desktop never spins the drain loop.
	const retryAfter = new Map<number, number>();
	// Consecutive transient admission failures per run — past the bound
	// the run settles terminal instead of re-queueing again.
	const admitAttempts = new Map<number, number>();
	const admitRetryBaseMs = deps.admitRetryMs ?? ADMIT_RETRY_BASE_MS;
	// In-flight monitors and admissions — close joins them so a paused
	// run is left durable, never mutated after close.
	const monitorTasks = new Set<Promise<void>>();
	const recoveryPending = new Set<number>();
	// Consecutive recovery cycles per run that have not yet re-attached
	// settlement — recovery is the only thing that re-attaches it, so
	// past the bound the run settles failed and frees its slot instead
	// of hanging forever. lastError keeps the newest failure text for
	// the terminal notice.
	const recoveryAttempts = new Map<number, { count: number; lastError: string }>();

	// ---------- the run row behind a Pi conversation ----------

	function rowForConversation(piConversationId: string): SubagentRun | null {
		// close() joins every lane/monitor before the run store goes
		// away, so a storage failure here is real corruption — let it
		// propagate rather than read as "unknown row".
		return runs.byPiConversation(piConversationId);
	}
	function requireRow(api: ToolExecutionApi): SubagentRun {
		const row = rowForConversation(String(api.conversationId));
		if (row === null) throw new SubagentError("tool call on an unknown subagent conversation");
		return row;
	}
	function requireLive(row: SubagentRun): void {
		if (closing || harnessClosed) {
			throw new SubagentError("the subagent harness is closed — this action cannot run");
		}
		if (row.stopRequested) {
			throw new SubagentError(`run #${row.id} is stopping — this action cannot run`);
		}
		if (row.status !== "running") {
			throw new SubagentError(`run #${row.id} is ${row.status} — not executing`);
		}
	}
	// The terminal write is idempotent: a replayed safe tool re-commits
	// the same outcome under its input revision; a second terminal call
	// never replaces the first.
	async function recordOutcome(api: ToolExecutionApi, outcome: RunOutcomeBody): Promise<void> {
		await api.commit(async (tx) => {
			const d = await tx.doc(RunDoc, api.conversationId);
			if (d.outcome === null) d.outcome = { rev: d.inputRev, ...outcome } as RunOutcome;
		}, ctx);
	}
	// Pi ids are branded numbers; goblin rows persist them as text.
	const asConv = (id: string) => Number(id) as ConversationId;
	const asSub = (id: string) => Number(id) as SubmissionId;

	const envs = new Map<string, SandboxEnv>();
	function envFor(origin: string): SandboxEnv {
		let env = envs.get(origin);
		if (env === undefined) {
			env = new SandboxEnv(deps.sandboxes, deps.transferRoot, origin);
			envs.set(origin, env);
		}
		return env;
	}

	// A claim that adopted/restarted/recreated the desktop returns a
	// lifecycle note — persist it on the run so the next tool result
	// carries it as a diagnostic. Worker notes arrive through the
	// sandbox's onLifecycle hook; computer rows aren't worker lease
	// holders, so this writes the row directly.
	function persistClaimNote(rowId: number, note: string | undefined): void {
		if (note === undefined || note === "") return;
		const cur = runs.get(rowId);
		if (cur === null || cur.stopRequested || cur.status === "stopped") return;
		runs.update(rowId, { lifecycleNote: note });
	}

	const {
		workerTools,
		computerTools,
		withLifecycleNote,
		withRunGuards,
		withLeaseRenew,
		withTerminalWrap,
	} = buildTools({
		deps,
		rowForConversation,
		requireRow,
		requireLive,
		recordOutcome,
		holderFor,
		persistClaimNote,
	});

	// abortTask joins the live invocation — it must not be awaited
	// from inside the very invocation it joins; the mark is what
	// refuses, the join is asynchronous.
	function abortPiTask(api: HookApi): void {
		void harness
			.abortTask(api.taskId, ctx)
			.catch((err) => log.warn("subagent task abort failed", err));
	}

	const requestCheckpointSchema = z.object({
		phase: z.literal("request"),
		cutoff: z.number().int().positive(),
	});

	// Re-drive input after a transient claim failure aborted a request.
	// It is goblin-voiced, not operator-voiced: the real input is already
	// a transcript entry, so the nudge only asks the run to continue.
	const RECOVERY_NUDGE =
		"[goblin] The previous model request aborted on transient infrastructure — your input is already in the transcript; continue the task.";

	// inputRev means the input this request consumed, never the newest
	// admitted intent — the request checkpoint's cutoff plus the newest
	// placed input at or below it says which one. Binding also clears a
	// stale committed outcome so it can't abort or mis-settle this rev.
	async function bindConsumedInput(
		api: HookApi,
		row: SubagentRun,
	): Promise<{ inputRev: number; outcome: RunOutcome | null }> {
		const fresh = runs.get(row.id);
		if (fresh === null) throw new SubagentError("run row vanished");
		return await harness.commit(async (tx) => {
			const task = await tx.task(api.taskId);
			if (
				task === undefined ||
				(task.state.status !== "pending" &&
					task.state.status !== "running" &&
					task.state.status !== "waiting")
			) {
				throw new SubagentError("generation task is not live — cannot bind its input");
			}
			const checkpoint = requestCheckpointSchema.parse(task.state.checkpoint);
			let consumed: number | null = null;
			for (let rev = fresh.inputRev; rev >= 1; rev--) {
				const sub = await tx.submissionByRequest(
					api.conversationId,
					`subagent:${row.id}:input:${rev}`,
				);
				if (
					sub !== undefined &&
					sub.type === "input" &&
					sub.entry !== undefined &&
					sub.entry <= checkpoint.cutoff
				) {
					consumed = rev;
					break;
				}
			}
			if (consumed === null) {
				throw new SubagentError(
					`no admitted input reached the request transcript (row rev ${fresh.inputRev}, cutoff ${checkpoint.cutoff})`,
				);
			}
			const d = await tx.doc(RunDoc, api.conversationId);
			d.inputRev = consumed;
			if (d.outcome !== null && d.outcome.rev !== consumed) d.outcome = null;
			return {
				inputRev: consumed,
				outcome: d.outcome === null ? null : { ...d.outcome },
			};
		}, ctx);
	}

	// Computer runs renew their desktop lease at every model request
	// too — a lost lease fails the request rather than letting input
	// land under the wrong holder. A transient claim failure rides the
	// bounded recovery budget instead: a typed DesktopLeaseError is
	// lost ownership, anything else keeps the run owned. A committed
	// terminal outcome also stops generation: an unknown or malformed
	// tool slot can leave a round "unanswered", and the monitor
	// settles the run from the doc.
	const requestGuard = hook(GenerationTask, {
		beforeRequest: async (_input, api, context) => {
			let row: SubagentRun | null;
			try {
				const doc = await api.snapshot(RunDoc, api.conversationId, context);
				row =
					doc?.runId !== null && doc !== undefined && doc !== null
						? runs.get(doc.runId)
						: rowForConversation(String(api.conversationId));
			} catch (err) {
				log.error("subagent request guard read failed — aborting", err, {
					conversation: String(api.conversationId),
					task: String(api.taskId),
				});
				abortPiTask(api);
				return undefined;
			}
			// No throw here — a hook failure is merely reported and the
			// request would proceed. Every guard refuses through the
			// real abort mark instead.
			if (row === null) {
				log.warn("subagent request on an unknown row — aborting", {
					conversation: String(api.conversationId),
				});
				abortPiTask(api);
				return undefined;
			}
			let bound: { inputRev: number; outcome: RunOutcome | null };
			try {
				bound = await bindConsumedInput(api, row);
			} catch (err) {
				log.error("subagent request input binding failed", err, {
					run: row.id,
					task: String(api.taskId),
				});
				abortPiTask(api);
				return undefined;
			}
			if (bound.outcome !== null) {
				// A committed outcome for this same input means the round
				// should already have terminated — a sibling call kept
				// it alive (a malformed slot can't terminate). The abort
				// mark signals the in-flight stream; the task ends
				// `aborted`, the input settles unanswered, and the
				// monitor classifies from the doc.
				log.warn("subagent generation continued past a committed outcome — aborting", {
					conversation: String(api.conversationId),
				});
				abortPiTask(api);
				return undefined;
			}
			if (row.status !== "running" || row.stopRequested) {
				abortPiTask(api);
				return undefined;
			}
			if (row.kind === "computer" && row.desktop !== null) {
				try {
					const claimed = await deps.desktops.claim(row.desktop, holderFor(row.id));
					persistClaimNote(row.id, claimed.note);
				} catch (err) {
					if (err instanceof DesktopLeaseError) {
						// Lost ownership is terminal — the request dies
						// unanswered and the monitor settles the run failed.
						log.warn("subagent lost its desktop lease — aborting the request", err, {
							run: row.id,
							desktop: row.desktop,
						});
						abortPiTask(api);
						return undefined;
					}
					// Any other claim failure is transient podman work —
					// killing the run for it would burn the recovery ruling.
					// The request still aborts (the lease is unverifiable),
					// but a continuation intent persists at a fresh rev
					// before returning: the aborted submission's settle reads
					// inputIntent and stays out, and the scan's bounded
					// recovery re-drives the run. The consumed input's
					// entry is already in the transcript, so the intent is
					// a nudge to continue — replaying the task brief would
					// inject a stale duplicate, and the aborted steer or
					// answer text is not stored to replay.
					log.warn(
						"subagent desktop claim failed — the request aborts; the run stays owned for recovery",
						err,
						{ run: row.id, desktop: row.desktop },
					);
					try {
						// Cancellation may hold the lane while joining this
						// hook. Cancel only the waiter, not the lane operation;
						// it must still serialize behind any provisional steer.
						await awaitWithContext(
							lane(row.id, async () => {
								const cur = runs.get(row.id);
								if (
									context.abortSignal?.aborted ||
									cur === null ||
									cur.status !== "running" ||
									cur.stopRequested
								)
									return;
								if (cur.inputIntent === null && cur.inputRev === bound.inputRev) {
									runs.update(row.id, {
										inputRev: cur.inputRev + 1,
										inputIntent: RECOVERY_NUDGE,
										inputMode: null,
									});
								}
								recoveryPending.add(row.id);
							}),
							context,
						);
					} finally {
						// A failed intent write must also refuse the request.
						abortPiTask(api);
					}
					return undefined;
				}
			}
			log.info("subagent model request", {
				run: row.id,
				kind: row.kind,
				model: specs.get(row.kind)?.modelId,
				conversation: row.conversationId,
				inputRev: bound.inputRev,
			});
			return undefined;
		},
		afterResponse: (message, api) => {
			const row = rowForConversation(String(api.conversationId));
			log.info("subagent model response", {
				run: row?.id ?? null,
				stopReason: message.stopReason,
				usage: message.usage,
			});
		},
	});

	const toolLog = hook(ToolTask, {
		beforeTool: async (call, api, context) => {
			await api.memo(`t0-${call.id}`, Date.now(), context);
			return undefined;
		},
		afterTool: async (call, result, api, context) => {
			const row = rowForConversation(String(api.conversationId));
			const t0 = await api.memo<number>(`t0-${call.id}`, context);
			log.info("subagent tool", {
				run: row?.id ?? null,
				kind: row?.kind ?? null,
				tool: call.name,
				callId: call.id,
				ok: result.isError !== true,
				ms: t0 === undefined ? null : Date.now() - t0,
			});
			return undefined;
		},
	});

	const workerExtension = defineExtension({
		name: "goblin-worker",
		tools: workerTools,
		hooks: [toolLog, requestGuard],
	});
	const computerExtension = defineExtension({
		name: "goblin-computer",
		tools: computerTools.map((t) => {
			if (t.name === "finish" || t.name === "ask_operator") return t;
			// Lifecycle-outermost like the worker wraps — a claim note
			// persisted mid-execute still reaches this call's result.
			return withLifecycleNote(withRunGuards(withLeaseRenew(withTerminalWrap(t))));
		}),
		hooks: [toolLog, requestGuard],
	});

	const registry = createRegistry();
	registry.install(workerExtension);
	registry.install(computerExtension);

	// The env seam: only worker rows get an ExecutionEnv — a computer
	// conversation has no filesystem or shell, by design.
	const storage = await openNodeSqliteStorage(deps.storagePath);
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			settings: {
				toolExecution: "sequential",
				...(deps.harnessSettings ?? {}),
			},
			env: (target) => {
				const row = rowForConversation(String(target.conversationId));
				if (row === null || row.kind !== "worker") return undefined;
				return envFor(row.conversationId);
			},
			// onReport is non-fatal (extension failures that did not
			// fail the calling operation) — log it, never close-state.
			// Real close is observed through subscribeClose below.
			onReport: (error) => {
				log.error("subagent harness report", error);
			},
		},
		ctx,
	);
	// The Session's real close edge — only this pauses admission for a
	// dead harness; durable rows still recover on the next boot.
	harness.subscribeClose(() => {
		harnessClosed = true;
	});

	const { importFiles, exportOutcomeFiles } = buildTransfer({
		deps,
		runs,
		throwIfHalted,
		isClosing: () => closing,
		isHarnessClosed: () => harnessClosed,
	});

	// ---------- notices ----------

	// One deterministic body per row state — the first delivery and
	// every retry carry the same fenced content: result, exported
	// paths, export refusals and the final screenshot all live inside
	// the event fence; only id/kind/status sit outside it.
	function noticeBody(row: SubagentRun): string {
		const body = noticeResult(row);
		return row.lifecycleNote === null ? body : `${body}\nLifecycle warning: ${row.lifecycleNote}`;
	}

	function noticeResult(row: SubagentRun): string {
		switch (row.status) {
			case "needs_input":
				return `Question: ${row.question ?? ""}`;
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
			});
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
		void task.finally(() => monitorTasks.delete(task));
	}

	// ---------- admission ----------

	function throwIfHalted(rowId: number): void {
		if (closing) throw new SubagentError("owner closing");
		const row = runs.get(rowId);
		if (row === null) throw new SubagentError("run row vanished");
		if (row.stopRequested || row.status === "stopped") throw new SubagentError("stopped");
	}

	// Admit's verdict distinguishes the non-admissions callers must
	// answer differently: "halted" means stop/close owns the row,
	// "blocked" is a lease conflict carrying the reason — a caller that
	// persisted an intent must roll it back or keep it pending, since
	// drain only retries queued rows — and "requeued" means a transient
	// failure deferred THIS admission: the intent stays persisted and
	// the retry path (drain backoff for a queued row, scan recovery for
	// a live one) owns it, so callers must not roll back.
	type AdmitOutcome =
		| { kind: "admitted" }
		| { kind: "halted" }
		| { kind: "blocked"; reason: string }
		| { kind: "requeued"; reason: string };

	// One admission path for all three input modes: initial (task),
	// resume (needs_input answer) and steer (live input). Every step
	// re-checks the persisted row before the next external effect.
	async function admit(row: SubagentRun, preserveRunning = false): Promise<AdmitOutcome> {
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
			// Persist the input intent + revision BEFORE admit: a crash
			// between submit and row write re-submits the same requestId
			// and gets the already-admitted submission back.
			const mode: InputMode =
				fresh.inputIntent !== null ? (fresh.inputMode ?? "initial") : "initial";
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
			if (closing || runs.get(row.id)?.stopRequested === true) return { kind: "halted" };
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
	function readmitOutcome(row: SubagentRun, outcome: AdmitOutcome): void {
		if (outcome.kind === "requeued") {
			throw new SubagentError(`re-admission could not land: ${outcome.reason}`);
		}
		if (outcome.kind === "blocked") {
			recoveryAttempts.set(row.id, {
				count: recoveryAttempts.get(row.id)?.count ?? 0,
				lastError: outcome.reason,
			});
			recoveryPending.add(row.id);
			log.warn("subagent re-admit blocked by a held lease — the running row keeps its slot", {
				run: row.id,
				reason: outcome.reason,
			});
		}
	}

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
				readmitOutcome(row, await admit(row, true));
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
			readmitOutcome(row, await admit(row, true));
			return undefined;
		});
		if (rev !== undefined) await finalize(boot.id, rev);
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
			if (live === null || live.status !== "running" || live.stopRequested) {
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
			if (afterCancel === null || afterCancel.stopRequested || afterCancel.status !== "running") {
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
			});
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

	// ---------- queue admission ----------

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
		const d = deps.desktops.get(row.desktop!);
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
		if (draining || closing || harnessClosed) {
			wantDrain = true;
			return;
		}
		draining = true;
		try {
			for (;;) {
				wantDrain = false;
				const free = config.maxRuns - runningIds().size;
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
		if (drainScheduled || closing || harnessClosed || !resumed) return;
		drainScheduled = true;
		queueMicrotask(() => {
			drainScheduled = false;
			void drain().catch((err) => log.error("subagent drain failed", err));
		});
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
				const outcome = await admit(runs.get(id)!, true);
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
					if (row === null || row.status !== "running" || row.stopRequested) {
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
