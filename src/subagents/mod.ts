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
import type { AuthStore } from "../auth.ts";
import type { SubagentsConfig } from "../config.ts";
import { DesktopLeaseError, type Desktops } from "../desktops.ts";
import { log } from "../log.ts";
import type { Sandboxes } from "../sandboxes.ts";
import {
	approvalDecisionInputSchema,
	MAX_INPUT_FILES,
	MAX_MESSAGE_CHARS,
	MAX_TASK_CHARS,
	type SubagentApprovalDecision,
	type SubagentApprovalInput,
	type SubagentCrashDecision,
	type SubagentKind,
	type SubagentRun,
	type SubagentRuns,
} from "../subagent-runs.ts";

import { type Admission, makeAdmission } from "./admission.ts";
import { makeApprovalGate } from "./approval-gate.ts";
import { makeDrain } from "./drain.ts";
import { SandboxEnv } from "./env.ts";
import { SubagentError } from "./errors.ts";
import { type KindSpec, kindSpec, type SubagentModelProfile } from "./models.ts";
import { makeRecovery, type Recovery } from "./recovery.ts";
import { makeRowAccess, type RowAccess } from "./row-access.ts";
import { makeSettle, type Settle } from "./settle.ts";
import { buildHarness, type HarnessBundle } from "./tools.ts";
import { buildTransfer } from "./transfer.ts";

export { SubagentError };

const ctx: Context = BACKGROUND_CONTEXT;
const SCAN_MS = 30_000;

export type { SubagentApprovalDecision } from "../subagent-runs.ts";
export { approvalLeaseDoc } from "./approval-gate.ts";

export interface SubagentsDeps {
	config: SubagentsConfig;
	runs: SubagentRuns;
	auth: Pick<AuthStore, "resolve">;
	sandboxes: Sandboxes;
	desktops: Desktops;
	storagePath: string;
	transferRoot: string;
	wake(conversationId: string, text: string): boolean;
	modelProfiles?: Partial<Record<SubagentKind, SubagentModelProfile>>;
	harnessSettings?: Record<string, unknown>;
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
	decide(id: number, conversationId: string, decision: SubagentApprovalInput): Promise<SubagentRun>;
	scan(): Promise<void>;
	resume(): Promise<void>;
	close(): Promise<void>;
}

export async function openSubagents(deps: SubagentsDeps): Promise<Subagents> {
	const config = deps.config;
	const runs = deps.runs;

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

	const lifecycle = { closing: false, resumed: false, harnessClosed: false };
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
	const retryAfter = new Map<number, number>();
	const admitAttempts = new Map<number, number>();

	const { scheduleDrain, drain } = makeDrain({
		runs,
		desktops: deps.desktops,
		maxRuns: config.maxRuns,
		lane,
		admit: (row) => admission.admit(row),
		retryAfter,
		halted: () => lifecycle.closing || lifecycle.harnessClosed,
		isResumed: () => lifecycle.resumed,
	});
	const recoveryPending = new Set<number>();
	const recoveryAttempts = new Map<number, { count: number; lastError: string }>();

	const access = makeRowAccess({
		runs,
		isClosing: () => lifecycle.closing,
		isHarnessClosed: () => lifecycle.harnessClosed,
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

	const gate = makeApprovalGate({
		runs,
		rowForConversation,
		recordOutcome,
		notify: (row) => settle.notify(row),
		releaseLeases: (row) => settle.releaseLeases(row),
		scheduleDrain,
		abortConversation: async (row) => {
			if (row.piConversationId === null || lifecycle.harnessClosed) return;
			try {
				const conv = await harness.conversation(asConv(row.piConversationId), ctx);
				// No waitForIdle — this task IS the work being aborted;
				// the throw ends it and the scan's stop retry marks it.
				void conv?.abort(ctx, { background: true }).catch((e) => {
					log.warn("abort after a failed park could not be fired", e, { run: row.id });
				});
			} catch (e) {
				log.warn("the failed-park abort could not be reached", e, { run: row.id });
			}
		},
	});

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
		recoveryNudge: (rowId, inputRev, context) => recovery.nudge(rowId, inputRev, context),
	});
	harness.subscribeClose(() => {
		lifecycle.harnessClosed = true;
	});

	const { importFiles, exportOutcomeFiles } = buildTransfer({
		transferRoot: deps.transferRoot,
		sandboxes: deps.sandboxes,
		desktops: deps.desktops,
		runs,
		throwIfHalted,
		halted: () => lifecycle.closing || lifecycle.harnessClosed,
	});

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
		isClosing: () => lifecycle.closing,
		isHarnessClosed: () => lifecycle.harnessClosed,
	});

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
		isClosing: () => lifecycle.closing,
		isResumed: () => lifecycle.resumed,
		isHarnessClosed: () => lifecycle.harnessClosed,
	});

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
		isClosing: () => lifecycle.closing,
		isHarnessClosed: () => lifecycle.harnessClosed,
	});

	const ticker = { id: null as ReturnType<typeof setInterval> | null };
	const b: OwnerBindings = {
		config,
		deps,
		runs,
		lifecycle,
		lane,
		lanes,
		ticker,
		refFor,
		harness,
		access,
		drain,
		scheduleDrain,
		admission,
		recovery,
		settle,
		recoveryPending,
	};
	const owner: Subagents = {
		start: (input, requestId) => ownerStart(b, input, requestId),
		list: (conv) => b.runs.listFor(conv),
		status: (id, conv) => ownerStatus(b, id, conv),
		send: (id, conv, message) => ownerSend(b, id, conv, message),
		stop: (id, conv) => ownerStop(b, id, conv),
		decide: (id, conv, decision) => ownerDecide(b, id, conv, decision),
		scan: () => ownerScan(b),
		resume: () => ownerResume(b),
		close: () => ownerClose(b),
	};
	return owner;
}

export async function openSubagentsGuarded(
	deps: SubagentsDeps,
	closeBudgetMs: number,
): Promise<Subagents | null> {
	let subagents: Subagents | null = null;
	try {
		subagents = await openSubagents(deps);
		await subagents.resume();
	} catch (err) {
		log.error("subagents startup failed — closing the owner before disabling", err);
		if (subagents !== null) {
			const closed = subagents
				.close()
				.then(() => true)
				.catch((closeErr: unknown) => {
					log.warn("subagents close after failed startup threw — disabling anyway", closeErr);
					return false;
				});
			const joined = await Promise.race([
				closed,
				new Promise<false>((r) => setTimeout(() => r(false), closeBudgetMs)),
			]);
			if (!joined) {
				log.warn("subagents close after failed startup wedged — disabling anyway", {
					budgetMs: closeBudgetMs,
				});
			}
		}
		subagents = null;
		log.error("subagents disabled — owner failed to open; fix the block and restart", err);
	}
	return subagents;
}

interface OwnerBindings {
	config: SubagentsConfig;
	deps: SubagentsDeps;
	runs: SubagentRuns;
	lifecycle: { closing: boolean; resumed: boolean; harnessClosed: boolean };
	lane: <T>(id: number, fn: () => Promise<T>) => Promise<T>;
	lanes: Map<number, Promise<void>>;
	ticker: { id: ReturnType<typeof setInterval> | null };
	refFor: (kind: SubagentKind) => KindSpec;
	harness: HarnessBundle["harness"];
	access: RowAccess;
	drain: () => Promise<void>;
	scheduleDrain: () => void;
	admission: Admission;
	recovery: Recovery;
	settle: Settle;
	recoveryPending: Set<number>;
}

async function ownerStart(
	b: OwnerBindings,
	input: SubagentStart,
	requestId?: string,
): Promise<SubagentRun> {
	if (b.lifecycle.closing) throw new SubagentError("subagents are closed");
	const kind = input.kind;
	b.refFor(kind);
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
		const existing = b.runs.listFor(input.conversationId).find((r) => r.requestId === requestId);
		if (existing !== undefined) return existing;
	}
	const row = b.runs.create({
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
	b.scheduleDrain();
	return row;
}

function ownerStatus(b: OwnerBindings, id: number, conv: string): SubagentRun | null {
	const row = b.runs.get(id);
	return row !== null && row.conversationId === conv ? row : null;
}

async function ownerSend(
	b: OwnerBindings,
	id: number,
	conv: string,
	message: string,
): Promise<SubagentRun> {
	if (b.lifecycle.closing) throw new SubagentError("subagents are closed");
	if (message.length === 0 || message.length > MAX_MESSAGE_CHARS) {
		throw new SubagentError(`message must be 1..${MAX_MESSAGE_CHARS} chars`);
	}
	return await b.lane(id, async () => {
		const row = b.runs.get(id);
		if (row === null || row.conversationId !== conv) {
			throw new SubagentError(`no subagent run #${id} in this conversation`);
		}
		if (row.stopRequested) {
			throw new SubagentError(`run #${id} is stopping`);
		}
		if (row.status !== "running" && row.status !== "needs_input") {
			throw new SubagentError(`run #${id} is ${row.status} — send needs running or needs_input`);
		}
		if (row.pendingApproval !== null) {
			throw new SubagentError(
				`run #${id} awaits an approval decision on an interrupted ${row.pendingApproval.tool} call — use decide`,
			);
		}
		if (row.piConversationId === null) {
			throw new SubagentError(`run #${id} has not been admitted yet`);
		}
		const rev = row.inputRev + 1;
		if (row.status === "needs_input") {
			b.runs.update(id, {
				inputRev: rev,
				inputIntent: message,
				inputMode: "resume",
				status: "queued",
			});
			log.info("subagent input queued", { run: id, rev });
			b.scheduleDrain();
			return b.runs.get(id)!;
		}
		// A persisted intent owns the next submission — overwriting its
		// revision breaks the requestId of a submission that may have landed.
		if (row.inputIntent !== null) {
			throw new SubagentError(
				`run #${id} has a persisted input still retrying — it owns the next submission`,
			);
		}
		const origRev = row.inputRev;
		b.runs.update(id, {
			inputRev: rev,
			inputIntent: message,
			inputMode: "steer",
		});
		const outcome = await b.admission.admit(b.runs.get(id)!, true);
		if (outcome.kind === "halted") {
			throw new SubagentError(`run #${id} was stopped mid-send`);
		}
		if (outcome.kind === "blocked") {
			// Refused before any submit — rolling back reuses no requestId.
			b.runs.update(id, { inputRev: origRev, inputIntent: null, inputMode: null });
			throw new SubagentError(`run #${id} cannot be steered — ${outcome.reason}`);
		}
		if (outcome.kind === "requeued") {
			// Past the claim a submission may already be placed — the
			// intent stays for the retry path rather than orphan it.
			throw new SubagentError(
				`run #${id} could not be steered — ${outcome.reason}; the steer stays persisted and retries`,
			);
		}
		return b.runs.get(id)!;
	});
}

async function ownerStop(b: OwnerBindings, id: number, conv: string): Promise<SubagentRun> {
	if (b.lifecycle.closing) throw new SubagentError("subagents are closed");
	const row = b.runs.get(id);
	if (row === null || row.conversationId !== conv) {
		throw new SubagentError(`no subagent run #${id} in this conversation`);
	}
	if (row.status === "done" || row.status === "failed") return row;
	if (row.status === "stopped") return row;
	b.runs.update(id, { stopRequested: true });
	log.info("subagent stop requested", { run: id, kind: row.kind });
	try {
		await b.settle.completeStop(id);
	} catch (err) {
		log.warn("subagent abort failed — stop stays pending", err, { run: id });
	}
	return b.runs.get(id)!;
}

async function ownerDecide(
	b: OwnerBindings,
	id: number,
	conv: string,
	decision: SubagentApprovalInput,
): Promise<SubagentRun> {
	if (b.lifecycle.closing) throw new SubagentError("subagents are closed");
	const parsed = approvalDecisionInputSchema.safeParse(decision);
	if (!parsed.success) {
		throw new SubagentError(`invalid approval decision: ${parsed.error.message}`);
	}
	const d: SubagentApprovalDecision = {
		...parsed.data,
		decidedBy: "goblin",
		outcome: "unverified",
	};
	return await b.lane(id, async () => {
		const row = b.runs.get(id);
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
		// Queued, not running: the drain's admit runs the same capacity
		// checks, so a parked run cannot jump the queue.
		const record: SubagentCrashDecision = {
			piTaskId: pending.piTaskId,
			callId: pending.callId,
			tool: pending.tool,
			args: pending.args,
			attempts: pending.attempts,
			decidedAt: Date.now(),
			decision: d,
		};
		const updated = b.runs.update(id, {
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
		b.scheduleDrain();
		return updated;
	});
}

async function ownerScan(b: OwnerBindings): Promise<void> {
	if (b.lifecycle.closing) throw new SubagentError("subagents are closed");
	for (const row of b.runs.pendingStops()) {
		try {
			await b.settle.completeStop(row.id);
		} catch (err) {
			log.warn("subagent stop retry failed", err, { run: row.id });
		}
	}
	for (const row of b.runs.pendingNotices()) {
		b.settle.notify(row);
	}
	await b.recovery.drive();
	await b.drain();
}

async function ownerResume(b: OwnerBindings): Promise<void> {
	if (b.lifecycle.closing) throw new SubagentError("subagents are closed");
	if (b.lifecycle.resumed) return;
	// Phase A — row decisions only, before ANY call that could
	// enable Pi's scheduler (wait/abort submit progress).
	const running = b.runs.unfinished().filter((r) => r.status === "running");
	if (running.length > b.config.maxRuns) {
		b.lifecycle.resumed = false;
		throw new SubagentError(
			`${running.length} runs are executing but subagents.maxRuns is ${b.config.maxRuns} — raise the cap or stop runs`,
		);
	}
	const leaseFailedConvs: string[] = [];
	for (const row of running) {
		if (row.kind !== "computer" || row.desktop === null) continue;
		try {
			const claimed = await b.deps.desktops.claim(row.desktop, b.access.holderFor(row.id));
			b.access.persistClaimNote(row.id, claimed.note);
		} catch (err) {
			if (!(err instanceof DesktopLeaseError)) {
				log.error("desktop boot reconciliation failed — run retained for recovery", err, {
					run: row.id,
					desktop: row.desktop,
				});
				throw err;
			}
			const msg = err instanceof Error ? err.message : String(err);
			const failed = b.runs.update(row.id, {
				status: "failed",
				error: `desktop ${row.desktop} is no longer held by this run: ${msg}`,
				noticePending: true,
				finishedAt: Date.now(),
			});
			b.settle.releaseLeases(failed);
			if (row.piConversationId !== null) leaseFailedConvs.push(row.piConversationId);
			log.warn("computer run lost its desktop lease at boot — failed", err, {
				run: row.id,
				desktop: row.desktop,
			});
		}
	}
	const pendingStopRows = b.runs.pendingStops();
	const live = await b.harness.inspect(ctx);
	const liveConvs = new Set<string>();
	for (const s of live.submissions) liveConvs.add(String(s.conversationId));
	for (const t of live.tasks) {
		if (t.record.conversationId !== undefined) {
			liveConvs.add(String(t.record.conversationId));
		}
	}
	const cancelConvs = new Set(leaseFailedConvs);
	for (const convId of liveConvs) {
		const row = b.runs.byPiConversation(convId);
		if (row === null || row.stopRequested || ["done", "failed", "stopped"].includes(row.status)) {
			cancelConvs.add(convId);
		}
	}
	// abort()/waitForIdle() enable Pi's scheduler, so every row decision
	// above is already persisted; abortTask does not resume scheduling.
	for (const task of live.tasks) {
		if (
			task.record.conversationId === undefined ||
			!cancelConvs.has(String(task.record.conversationId))
		)
			continue;
		await b.harness.abortTask(task.record.id, ctx);
	}
	for (const convId of cancelConvs) {
		try {
			const conv = await b.harness.conversation(b.access.asConv(convId), ctx);
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
			await b.settle.completeStop(row.id);
		} catch (err) {
			log.error("subagent boot stop failed — refusing resume", err, { run: row.id });
			throw err;
		}
	}
	for (const row of b.runs.unfinished()) {
		if (row.stopRequested) continue;
		if (row.status === "queued") continue;
		if (row.status === "needs_input") {
			if (row.pendingApproval !== null) {
				try {
					await b.recovery.recoverParked(row.id);
				} catch (err) {
					log.error(
						"subagent parked-approval reattach failed — the row stays owned for a scan retry",
						err,
						{ run: row.id },
					);
					b.recoveryPending.add(row.id);
				}
				continue;
			}
			b.settle.releaseLeases(row);
			continue;
		}
		try {
			await b.recovery.recoverRun(row);
		} catch (err) {
			log.error("subagent recovery failed — the row stays owned for a scan retry", err, {
				run: row.id,
			});
			b.recoveryPending.add(row.id);
		}
	}
	b.lifecycle.resumed = true;
	b.harness.resume();
	b.ticker.id = setInterval(() => {
		void ownerScan(b).catch((err) => log.error("subagent scan failed", err));
	}, SCAN_MS);
	b.ticker.id.unref?.();
	b.scheduleDrain();
}

async function ownerClose(b: OwnerBindings): Promise<void> {
	if (b.lifecycle.closing) return;
	b.lifecycle.closing = true;
	if (b.ticker.id !== null) clearInterval(b.ticker.id);
	await Promise.allSettled([...b.lanes.values()]);
	await b.harness.close(ctx);
	b.lifecycle.harnessClosed = true;
	for (;;) {
		const pending = [...b.lanes.values(), ...b.settle.pendingMonitors()];
		if (pending.length === 0) break;
		await Promise.allSettled(pending);
	}
}
