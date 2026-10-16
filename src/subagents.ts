// The subagent runtime (design/subagents.md): two purpose-typed runs —
// worker (coding tools over the origin conversation's sandbox) and
// computer (the desktop pool's observation/input surface). This is the
// ONLY module that imports Pi Durable / pi-ai / chord (the herdr.ts
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

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
	createModels,
	createProvider,
	envApiKeyAuth,
	InMemoryCredentialStore,
	Type,
	type CredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	hook,
	ToolTask,
	GenerationTask,
	Harness,
	type Submission,
	type HookApi,
	type ToolDiagnostic,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
	type ConversationId,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type {
	ExecutionEnv,
	ExecutionError,
	FileInfo,
	Result,
	ShellExecOptions,
	ShellExecResult,
	TextLine,
	TextLineReader,
} from "@earendil-works/pi-durable/env";
import {
	err,
	FileError,
	ok,
	ExecutionError as PiExecutionError,
} from "@earendil-works/pi-durable/env";
import { z } from "zod";
import type { AuthStore } from "./auth.ts";
import type { SubagentsConfig } from "./config.ts";
import {
	CUA_TOOLS,
	DesktopError,
	DesktopLeaseError,
	type Desktops,
	type CuaTool,
	type LeaseHolder,
} from "./desktops.ts";
import { PodmanError } from "./podman.ts";
import { SandboxError, type Sandboxes } from "./sandboxes.ts";
import {
	approvalDecisionSchema,
	MAX_INPUT_FILES,
	MAX_MESSAGE_CHARS,
	MAX_RESULT_CHARS,
	MAX_TASK_CHARS,
	type InputMode,
	type PendingApproval,
	type SubagentApprovalDecision,
	type SubagentKind,
	type SubagentRun,
	type SubagentRuns,
} from "./subagent-runs.ts";
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
import { exportNamedBytes, readImport } from "./box-files.ts";
import { log } from "./log.ts";

export class SubagentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentError";
	}
}

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
const READ_CAP = 100 * 1024 * 1024;
const SHELL_TIMEOUT_DEFAULT_S = 60;
const SHELL_TIMEOUT_CAP_S = 600;
const SPILL_TAIL_BYTES = 256 * 1024;
const SPILL_CAP_BYTES = 100 * 1024 * 1024;
const INSPECT_STATE_CAP = 200_000;

// ---------- the typed run document ----------

// The crash gap this closes: goblin's row and Pi's transcript are two
// stores. The outcome is committed HERE, inside the tool invocation,
// before the tool returns — and it carries the input revision it
// answered, so a resume that persisted new intent but crashed before
// clearing the doc can't be mis-settled by the old question's outcome.
type RunOutcomeBody =
	| { kind: "done"; result: string; files: string[] }
	| { kind: "ask"; question: string }
	// Written by the approval gate when the operator abandons a
	// crash-ambiguous call — settlement reports the verdict, not a
	// generic "no terminal tool" failure.
	| { kind: "aborted"; reason: string };
type RunOutcome = RunOutcomeBody & { rev: number };
type RunDocState = {
	runId: number | null;
	/** The input revision the conversation is currently answering. */
	inputRev: number;
	outcome: RunOutcome | null;
};
const RunDoc = defineDoc<RunDocState>({
	kind: "goblin.subagent-run",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ runId: null, inputRev: 0, outcome: null }),
});

// ---------- the crash-approval lease ----------

// Every side-effecting subagent tool is lease-gated (design/subagents.md
// → Crash approval): a process kill between the call's durable dispatch
// and its result commit leaves "dispatched, effect unobserved" — and only
// an operator decision may say what that means. The lease is a
// task-scoped pi-durable doc keyed by the tool task's own id, so claim,
// decision, and a completed-but-unsettled result share the tool task's
// commit line and survive SIGKILL with exactly the durability the
// transcript has. The run row's pendingApproval is only a routing mirror
// — this doc is the truth.

// The decision type and its boundary schema live in subagent-runs.ts —
// the verdict now persists on the row's pendingApproval mirror.
export type { SubagentApprovalDecision } from "./subagent-runs.ts";

const ApprovalLeaseSchema = z.discriminatedUnion("state", [
	z.object({ state: z.literal("absent") }),
	z.object({ state: z.literal("claimed"), attempts: z.number() }),
	z.object({
		state: z.literal("decided"),
		attempts: z.number(),
		decision: approvalDecisionSchema,
	}),
	z.object({ state: z.literal("done"), result: z.unknown() }),
]);

type JsonObject = { [key: string]: JsonValue };

// Flat storage row so whole-value writes typecheck; nulls, not absent
// keys — doc values are strict JSON. Reads validate the persisted shape
// against ApprovalLeaseSchema at the boundary (readApprovalLease).
type ApprovalLeaseRow = {
	state: "absent" | "claimed" | "decided" | "done";
	attempts: number | null;
	decision: JsonValue | null;
	result: JsonValue | null;
};

const approvalClaimRow = (attempts: number): ApprovalLeaseRow => ({
	state: "claimed",
	attempts,
	decision: null,
	result: null,
});
const approvalDecidedRow = (attempts: number, decision: JsonValue): ApprovalLeaseRow => ({
	state: "decided",
	attempts,
	decision,
	result: null,
});
const approvalDoneRow = (result: JsonValue): ApprovalLeaseRow => ({
	state: "done",
	attempts: null,
	decision: null,
	result,
});

// Exported for the crash tests: a pre-seeded `done` lease is how the
// result-committed-but-unobserved window is exercised without racing a
// real kill.
export const approvalLeaseDoc = defineDoc<ApprovalLeaseRow>({
	kind: "goblin.subagent-approval-lease",
	version: 1,
	scope: "task",
	initial: () => ({ state: "absent", attempts: null, decision: null, result: null }),
});

function readApprovalLease(
	snapshot: Readonly<JsonObject> | undefined,
): ApprovalLeaseRow | undefined {
	if (snapshot === undefined) return undefined;
	const parsed = ApprovalLeaseSchema.safeParse(snapshot);
	if (!parsed.success) {
		throw new SubagentError(`corrupt approval lease: ${parsed.error.message}`);
	}
	const row = parsed.data;
	return {
		state: row.state,
		attempts: row.state === "claimed" || row.state === "decided" ? row.attempts : null,
		decision: row.state === "decided" ? (row.decision as JsonValue) : null,
		result: row.state === "done" ? (row.result as JsonValue) : null,
	};
}

/** The claim generation and any prior decision a validated lease carries. */
function approvalLeaseGeneration(lease: ApprovalLeaseRow | undefined): {
	attempts: number;
	decision: SubagentApprovalDecision | undefined;
} {
	if (lease?.state === "claimed") {
		return { attempts: lease.attempts ?? 0, decision: undefined };
	}
	if (lease?.state === "decided") {
		// readApprovalLease validated the decision's shape; the cast only
		// restores the type zod already checked.
		return {
			attempts: lease.attempts ?? 0,
			decision: lease.decision as SubagentApprovalDecision,
		};
	}
	return { attempts: 0, decision: undefined };
}

function asJson<T>(value: T): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function commitApprovalLease(
	api: ToolExecutionApi,
	lease: ApprovalLeaseRow,
	context: Context,
): Promise<void> {
	await api.commit(async (tx) => {
		const draft = await tx.doc(approvalLeaseDoc, api.taskId);
		draft.state = lease.state;
		draft.attempts = lease.attempts;
		draft.decision = lease.decision;
		draft.result = lease.result;
	}, context);
}

// ---------- model construction (pinned recipe) ----------

const KIND_MODEL_ID: Record<SubagentKind, string> = {
	worker: "glm-5.3",
	computer: "glm-5.3-flash",
};

// An explicit model profile is the experiment seam (design/subagents.md):
// a constructor-supplied catalog entry for one approved non-GLM route.
// It carries model shape only — provider/baseUrl/credential stay bound
// by the configured model block; the production pin policy below is
// unchanged for callers that pass none.
export const subagentModelProfileSchema = z
	.object({
		id: z.string().min(1),
		input: z.array(z.enum(["text", "image"])).min(1),
		reasoning: z.boolean(),
		contextWindow: z.number().int().positive().safe(),
		maxTokens: z.number().int().positive().safe(),
		cost: z
			.object({
				input: z.number().finite().nonnegative(),
				output: z.number().finite().nonnegative(),
				cacheRead: z.number().finite().nonnegative(),
				cacheWrite: z.number().finite().nonnegative(),
			})
			.strict(),
		compat: z
			.object({
				supportsStore: z.literal(false),
				supportsDeveloperRole: z.literal(false),
				supportsReasoningEffort: z.literal(false),
				maxTokensField: z.literal("max_tokens"),
			})
			.strict(),
	})
	.strict()
	.refine((p) => p.maxTokens <= p.contextWindow, {
		message: "maxTokens must not exceed contextWindow",
	});
export type SubagentModelProfile = z.infer<typeof subagentModelProfileSchema>;

type KindSpec = {
	kind: SubagentKind;
	providerId: string;
	modelId: string;
	thinking: "off" | "low" | "high";
	catalog: Model<"openai-completions">;
};

function kindSpec(config: SubagentsConfig, kind: SubagentKind, profile?: unknown): KindSpec {
	const block = config[kind];
	if (block === undefined) {
		throw new SubagentError(`subagents.${kind} is not configured`);
	}
	const model = block.model;
	const providerId = `goblin-${kind}`;
	if (profile !== undefined) {
		const parsed = subagentModelProfileSchema.safeParse(profile);
		if (!parsed.success) {
			// A rejected profile must not echo the caller's object — it
			// could carry anything.
			throw new SubagentError(`subagents.${kind} explicit model profile failed schema validation`);
		}
		const p = parsed.data;
		if (p.id !== model.id) {
			throw new SubagentError(
				`subagents.${kind} explicit model profile id does not match the configured model.id`,
			);
		}
		const needed = kind === "computer" ? ["text", "image"] : ["text"];
		const inputs = new Set<string>(p.input);
		if (!needed.every((i) => inputs.has(i))) {
			throw new SubagentError(
				`subagents.${kind} explicit model profile does not admit the required input modality`,
			);
		}
		if (model.thinking !== "off") {
			throw new SubagentError(
				`subagents.${kind} explicit model profile requires model.thinking "off" — no unverifiable effort mapping`,
			);
		}
		const catalog: Model<"openai-completions"> = {
			...p,
			name: p.id,
			api: "openai-completions",
			provider: providerId,
			baseUrl: model.baseUrl,
		};
		return { kind, providerId, modelId: p.id, thinking: "off", catalog };
	}
	if (model.id !== KIND_MODEL_ID[kind]) {
		throw new SubagentError(
			`subagents.${kind}.model.id must be ${KIND_MODEL_ID[kind]}, got ${JSON.stringify(model.id)} — no alternate subagent models`,
		);
	}
	if (model.thinking !== "low" && model.thinking !== "high") {
		throw new SubagentError(
			`subagents.${kind}.model.thinking must be "low" or "high" (the z.ai catalog maps no other level), got ${JSON.stringify(model.thinking)}`,
		);
	}
	const catalog = ZAI_MODELS[model.id as keyof typeof ZAI_MODELS];
	if (catalog === undefined) {
		throw new SubagentError(
			`model ${model.id} is not in the pinned pi-ai z.ai catalog — pin drifted, re-check the catalog`,
		);
	}
	return { kind, providerId, modelId: catalog.id, thinking: model.thinking, catalog };
}

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
	/** Operator verdict on a run parked by the crash-approval gate —
	 *  persists the decision on the row and queues the continuation
	 *  for scheduler admission (a global slot plus resource checks);
	 *  the grant resolves the parked tool task. Only valid on a
	 *  `needs_input` row carrying `pendingApproval`. */
	decide(
		id: number,
		conversationId: string,
		decision: SubagentApprovalDecision,
	): Promise<SubagentRun>;
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

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------- worker execution env over Sandboxes ----------

const STAGE = join("/tmp", ".goblin-env-stage");

function envErr(
	code: ConstructorParameters<typeof FileError>[0],
	msg: string,
	path?: string,
): Result<never, FileError> {
	return err<never, FileError>(new FileError(code, msg, path));
}
function aborted(): Result<never, FileError> {
	return envErr("aborted", "operation aborted by the run's cancellation context");
}

const FILE_KINDS = new Map<string, FileInfo["kind"]>([
	["regular file", "file"],
	["regular empty file", "file"],
	["directory", "directory"],
	["symbolic link", "symlink"],
]);

class SandboxEnv implements ExecutionEnv {
	readonly id: string;
	cwd = "/work";
	constructor(
		private readonly sandboxes: Sandboxes,
		private readonly transferRoot: string,
		private readonly origin: string,
	) {
		this.id = `goblin-sandbox:${origin}`;
	}
	private resolve(path: string): string {
		return posix.normalize(path.startsWith("/") ? path : `${this.cwd}/${path}`);
	}
	private async run(
		argv: string[],
		opts: { timeoutMs?: number; maxOutput?: number } | undefined,
		context: Context,
	): Promise<{
		stdout: string;
		stderr: string;
		exitCode: number | null;
		timedOut: boolean;
		truncated: boolean;
	}> {
		// A pre-aborted context makes zero sandbox calls — a stopped
		// write must not keep running.
		if (context.abortSignal?.aborted) {
			return { stdout: "", stderr: "", exitCode: null, timedOut: false, truncated: false };
		}
		const { result } = await this.sandboxes.execArgv(this.origin, argv, {
			timeoutMs: opts?.timeoutMs ?? SHELL_TIMEOUT_DEFAULT_S * 1000,
			maxOutput: opts?.maxOutput ?? 4 * 1024 * 1024,
			...(context.abortSignal !== undefined ? { abortSignal: context.abortSignal } : {}),
		});
		return result;
	}
	private async check(
		r: {
			stdout: string;
			stderr: string;
			exitCode: number | null;
			timedOut: boolean;
			truncated: boolean;
		},
		path: string | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		if (r.timedOut) {
			return envErr("unknown", "sandbox command timed out", path);
		}
		if (r.exitCode === null) {
			return aborted();
		}
		if (r.truncated) {
			return envErr("unknown", "sandbox command output was truncated — result incomplete", path);
		}
		if (r.exitCode !== 0) {
			return envErr(
				path === undefined ? "unknown" : await this.fileError(path, context),
				`${path ?? "command"}: ${r.stderr.trim()}`,
				path,
			);
		}
		return ok<void, FileError>(undefined);
	}
	private async fileError(
		path: string,
		context: Context,
	): Promise<ConstructorParameters<typeof FileError>[0]> {
		// Only our probe's exit statuses classify errors; filenames and localized
		// command diagnostics never participate in control flow.
		const probe = await this.run(
			[
				"/bin/sh",
				"-c",
				'if [ -d "$1" ]; then exit 83; fi; p="$1"; while [ "$p" != / ]; do p=$(dirname -- "$p"); [ ! -e "$p" ] || [ -d "$p" ] || exit 82; [ ! -d "$p" ] || [ -x "$p" ] || exit 81; done; [ -e "$1" ] || [ -L "$1" ] || exit 80; [ -r "$1" ] && [ -w "$1" ] || exit 81; exit 1',
				"file-error",
				this.resolve(path),
			],
			undefined,
			context,
		);
		if (probe.timedOut || probe.truncated) return "unknown";
		if (context.abortSignal?.aborted) return "aborted";
		switch (probe.exitCode) {
			case 80:
				return "not_found";
			case 81:
				return "permission_denied";
			case 82:
				return "not_directory";
			case 83:
				return "is_directory";
			default:
				return "unknown";
		}
	}
	private async runOut(
		argv: string[],
		path: string,
		context: Context,
		codes: Readonly<Record<number, ConstructorParameters<typeof FileError>[0]>> = {},
	): Promise<Result<string, FileError>> {
		const r = await this.run(argv, undefined, context);
		const code = r.exitCode === null ? undefined : codes[r.exitCode];
		if (!r.timedOut && !r.truncated && !context.abortSignal?.aborted && code !== undefined) {
			return envErr(code, `${path}: ${r.stderr.trim()}`, path);
		}
		const bad = await this.check(r, path, context);
		if (!bad.ok) return bad;
		return ok<string, FileError>(r.stdout);
	}
	absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
		if (context.abortSignal?.aborted) return Promise.resolve(aborted());
		return Promise.resolve(ok<string, FileError>(this.resolve(path)));
	}
	joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return Promise.resolve(ok<string, FileError>(posix.join(...parts)));
	}
	private async catBytes(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		if (context.abortSignal?.aborted) return aborted();
		const abs = this.resolve(path);
		const { result } = await this.sandboxes.execBytesArgv(this.origin, ["cat", "--", abs], {
			timeoutMs: 120_000,
			maxOutput: READ_CAP,
			...(context.abortSignal !== undefined ? { abortSignal: context.abortSignal } : {}),
		});
		if (result.truncated) {
			return envErr("unknown", `${path} exceeds the 100 MiB read bound — no partial read`, path);
		}
		if (result.timedOut || result.exitCode !== 0) {
			return envErr(await this.fileError(path, context), `${path}: ${result.stderr.trim()}`, path);
		}
		if (context.abortSignal?.aborted) return aborted();
		return ok<Uint8Array, FileError>(result.stdout);
	}
	readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.catBytes(path, context).then((r) =>
			r.ok ? ok<string, FileError>(new TextDecoder().decode(r.value)) : r,
		);
	}
	async openTextLineReader(
		path: string,
		context: Context,
	): Promise<Result<TextLineReader, FileError>> {
		const r = await this.catBytes(path, context);
		if (!r.ok) return r;
		// Split keeps the real line structure: "" → EOF at once,
		// "x" → one unterminated line, "x\n" → one terminated line,
		// "x\ny" → terminated then unterminated.
		const raw = new TextDecoder().decode(r.value);
		const lines =
			raw === "" ? [] : raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
		let i = 0;
		return ok<TextLineReader, FileError>({
			readLine: (): Promise<Result<TextLine | undefined, FileError>> => {
				if (i >= lines.length) {
					return Promise.resolve(ok<TextLine | undefined, FileError>(undefined));
				}
				const text = lines[i++] ?? "";
				const terminated = i < lines.length || raw.endsWith("\n");
				return Promise.resolve(ok<TextLine, FileError>({ text, terminated }));
			},
			close: () => Promise.resolve(),
		});
	}
	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		const r = await this.readTextFile(path, context);
		if (!r.ok) return r;
		// Same line semantics as openTextLineReader: "" → [],
		// "x\n" → ["x"], "x\ny" → ["x","y"].
		const lines =
			r.value === ""
				? []
				: r.value.endsWith("\n")
					? r.value.slice(0, -1).split("\n")
					: r.value.split("\n");
		return ok<string[], FileError>(
			options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines),
		);
	}
	readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.catBytes(path, context);
	}
	private async stage(
		content: string | Uint8Array,
		destScript: string,
		path: string,
		context: Context,
	): Promise<Result<void, FileError>> {
		if (context.abortSignal?.aborted) return aborted();
		// Content never enters argv: host staging under transferRoot,
		// cpIn into the guest, an in-guest shell op moves it. Cleanup must
		// also cover cancellation before that script ever dispatches.
		mkdirSync(this.transferRoot, { recursive: true });
		const staged = join(
			this.transferRoot,
			`w-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		);
		const guest = `${STAGE}-${Math.random().toString(16).slice(2)}`;
		let cleanup: string | null = null;
		try {
			if (context.abortSignal?.aborted) return aborted();
			// Inside the finally's reach: a failed write must not leave
			// the staged file behind in transferRoot.
			await Bun.write(staged, content);
			if (context.abortSignal?.aborted) return aborted();
			await this.sandboxes.cpIn(
				this.origin,
				staged,
				guest,
				context.abortSignal === undefined ? undefined : { abortSignal: context.abortSignal },
			);
			if (context.abortSignal?.aborted) return aborted();
			const r = await this.run(
				["/bin/sh", "-c", destScript, "env", guest, this.resolve(path)],
				undefined,
				context,
			);
			const bad = await this.check(r, path, context);
			if (!bad.ok) return bad;
		} catch (err) {
			if (context.abortSignal?.aborted) return aborted();
			throw err;
		} finally {
			cleanup = await this.guestRm([guest]);
			rmSync(staged, { force: true });
		}
		// Only a successful staged write reaches here — an error or
		// thrown return above already owns the outcome; cleanup's
		// failure is the operation's error, never a silent leak.
		if (cleanup !== null) {
			return envErr("unknown", `${path}: guest staging cleanup failed: ${cleanup}`, path);
		}
		return ok<void, FileError>(undefined);
	}
	writeFile(
		path: string,
		content: string | Uint8Array,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.stage(
			content,
			'mkdir -p -- "$(dirname -- "$2")" && cat -- "$1" > "$2"; rc=$?; rm -f -- "$1"; exit $rc',
			path,
			context,
		);
	}
	appendFile(
		path: string,
		content: string | Uint8Array,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.stage(
			content,
			'mkdir -p -- "$(dirname -- "$2")" && cat -- "$1" >> "$2"; rc=$?; rm -f -- "$1"; exit $rc',
			path,
			context,
		);
	}
	async truncateFile(
		path: string,
		size: number,
		context: Context,
	): Promise<Result<void, FileError>> {
		const r = await this.run(
			["truncate", "-s", String(size), "--", this.resolve(path)],
			undefined,
			context,
		);
		return this.check(r, path, context);
	}
	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		const r = await this.run(["sync"], undefined, context);
		const bad = await this.check(r, path, context);
		if (!bad.ok) return envErr("unknown", `sync failed for ${path}`, path);
		return ok<void, FileError>(undefined);
	}
	async renameFile(
		sourcePath: string,
		destinationPath: string,
		context: Context,
	): Promise<Result<void, FileError>> {
		const r = await this.run(
			["mv", "--", this.resolve(sourcePath), this.resolve(destinationPath)],
			undefined,
			context,
		);
		return this.check(r, sourcePath, context);
	}
	private parseStat(
		stdout: string,
		path: string,
	): Result<{ kind: FileInfo["kind"]; size: number; mtimeMs: number }, FileError> {
		const [f, s, m] = stdout.trim().split("|");
		const kind = FILE_KINDS.get(f ?? "");
		const size = Number(s);
		const mtime = Number(m);
		if (kind === undefined) {
			return envErr(
				"not_supported",
				`${path}: unsupported file kind ${JSON.stringify(f ?? "")}`,
				path,
			);
		}
		if (!Number.isFinite(size) || !Number.isFinite(mtime)) {
			return envErr("unknown", `${path}: malformed stat output ${JSON.stringify(stdout)}`, path);
		}
		return ok({ kind, size, mtimeMs: mtime * 1000 });
	}
	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		// The filename is never echoed — it's already the argv — so a
		// name with '|' or a newline can't corrupt the numeric fields.
		const abs = this.resolve(path);
		const out = await this.runOut(["stat", "-c", "%F|%s|%Y", "--", abs], path, context);
		if (!out.ok) return out;
		const st = this.parseStat(out.value, path);
		if (!st.ok) return st;
		return ok<FileInfo, FileError>({
			name: basename(abs),
			path: abs,
			...st.value,
		});
	}
	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const abs = this.resolve(path);
		// NUL-separated records: name\0 then "kind|size|mtime\n"\0 —
		// a filename with '|', '\n' or spaces can't corrupt fields.
		const out = await this.runOut(
			[
				"/bin/sh",
				"-c",
				'if [ ! -d "$1" ]; then if [ -e "$1" ] || [ -L "$1" ]; then printf "not a directory: %s\n" "$1" >&2; exit 3; else printf "no such directory: %s\n" "$1" >&2; exit 2; fi; fi; for f in "$1"/.[!.]* "$1"/..?* "$1"/*; do [ -e "$f" ] || [ -L "$f" ] || continue; printf "%s\\0" "$f"; stat -c "%F|%s|%Y" -- "$f" || exit 1; printf "\\0"; done',
				"ls",
				abs,
			],
			path,
			context,
			{ 2: "not_found", 3: "not_directory" },
		);
		if (!out.ok) return out;
		const chunks = out.value.split("\0");
		const infos: FileInfo[] = [];
		for (let i = 0; i + 1 < chunks.length; i += 2) {
			const name = chunks[i]!;
			const stats = chunks[i + 1]!.trim();
			if (stats === "") continue;
			const st = this.parseStat(stats, name);
			if (!st.ok) return st;
			infos.push({ name: basename(name), path: name, ...st.value });
		}
		return ok<FileInfo[], FileError>(infos);
	}
	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		// busybox realpath takes no `--`; resolve() always yields an
		// absolute path so there is no flag ambiguity.
		const out = await this.runOut(["realpath", this.resolve(path)], path, context);
		if (!out.ok) return out;
		// realpath emits exactly one trailing newline — strip only it:
		// a filename ending in "\n" must survive.
		return ok<string, FileError>(out.value.endsWith("\n") ? out.value.slice(0, -1) : out.value);
	}
	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const r = await this.run(
			["/bin/sh", "-c", 'test -e "$1" || test -L "$1"', "t", this.resolve(path)],
			undefined,
			context,
		);
		if (r.timedOut || r.exitCode === null) return envErr("unknown", "exists timed out", path);
		return ok<boolean, FileError>(r.exitCode === 0);
	}
	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const r = await this.run(
			options?.recursive
				? ["mkdir", "-p", "--", this.resolve(path)]
				: ["mkdir", "--", this.resolve(path)],
			undefined,
			context,
		);
		return this.check(r, path, context);
	}
	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const argv = ["rm"];
		if (options?.recursive) argv.push("-r");
		if (options?.force) argv.push("-f");
		argv.push("--", this.resolve(path));
		const r = await this.run(argv, undefined, context);
		return this.check(r, path, context);
	}
	async createTempDir(
		prefix: string | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const out = await this.runOut(
			["mktemp", "-d", `/tmp/${prefix ?? "env"}.XXXXXX`],
			"/tmp",
			context,
		);
		if (!out.ok) return out;
		return ok<string, FileError>(out.value.trim());
	}
	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const suffix = options?.suffix ?? "";
		const out = await this.runOut(
			[
				"/bin/sh",
				"-c",
				't=$(mktemp "/tmp/$1.XXXXXX") || exit 1; [ -z "$2" ] || mv "$t" "$t$2"; echo "$t$2"',
				"mk",
				options?.prefix ?? "env",
				suffix,
			],
			"/tmp",
			context,
		);
		if (!out.ok) return out;
		return ok<string, FileError>(out.value.trim());
	}
	// rm of guest temp files is never silent: a nonzero exit, a
	// timeout or a thrown exec comes back as a detail string — a
	// caller whose operation succeeded turns it into the operation's
	// error, while one already holding a primary failure keeps it.
	// The warn is the record either way.
	private async guestRm(paths: string[]): Promise<string | null> {
		try {
			const { result } = await this.sandboxes.execArgv(this.origin, ["rm", "-f", "--", ...paths], {
				timeoutMs: 15_000,
				maxOutput: 64 * 1024,
			});
			if (result.timedOut || result.exitCode !== 0) {
				log.warn("sandbox env cleanup failed", {
					conversation: this.origin,
					paths,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
				});
				return result.timedOut
					? `rm timed out: ${paths.join(" ")}`
					: `rm exited ${result.exitCode ?? "killed"}: ${result.stderr.trim().slice(0, 200)}`;
			}
			return null;
		} catch (e) {
			log.warn("sandbox env cleanup failed", e, { conversation: this.origin, paths });
			return e instanceof Error ? e.message : String(e);
		}
	}
	async exec(
		command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		if (context.abortSignal?.aborted) {
			return err<ShellExecResult, ExecutionError>(
				new PiExecutionError("aborted", "command aborted"),
			);
		}
		// Output lands in a guest spill file; what rides back to the
		// model is the tail within the harness's thresholds, and a
		// reported spill path is a real, retained file — never a
		// phantom. `ulimit -f` bounds the file itself so a runaway
		// command can't write past the 100 MiB wall.
		const timeoutS = Math.min(options?.timeout ?? SHELL_TIMEOUT_DEFAULT_S, SHELL_TIMEOUT_CAP_S);
		const pairs = Object.entries(options?.env ?? {});
		for (const [k] of pairs) {
			if (!ENV_NAME_RE.test(k)) {
				return err<ShellExecResult, ExecutionError>(
					new PiExecutionError("spawn_error", `invalid env name ${JSON.stringify(k)}`),
				);
			}
		}
		const tag = Math.random().toString(16).slice(2);
		const spill = `/tmp/.goblin-spill-${tag}`;
		const rcpath = `/tmp/.goblin-rc-${tag}`;
		const cwd = options?.cwd ?? this.cwd;
		const capBlocks = Math.ceil(SPILL_CAP_BYTES / 512);
		const argv = [
			"env",
			...(options?.inheritEnv === false ? ["-i"] : []),
			...pairs.map(([k, v]) => `${k}=${v}`),
			"/bin/sh",
			"-c",
			'cd "$1" || { echo "cd failed: $1" >&2; exit 96; }; ( ulimit -f "$5" 2>/dev/null; /bin/sh -c "$4" >"$2" 2>&1; printf %s "$?" >"$3" )',
			"env-shell",
			cwd,
			spill,
			rcpath,
			command,
			String(capBlocks),
		];
		const { result } = await this.sandboxes.execArgv(this.origin, argv, {
			timeoutMs: timeoutS * 1000,
			maxOutput: 4 * 1024 * 1024,
			...(context.abortSignal !== undefined ? { abortSignal: context.abortSignal } : {}),
		});
		if (result.timedOut) {
			// The sandbox restarted after the kill — the spill file
			// survived (files are kept) and stays readable; report it.
			await this.guestRm([rcpath]);
			const e = new PiExecutionError(
				"timeout",
				`command timed out after ${timeoutS}s — partial output at ${spill}`,
			);
			e.spillPath = spill;
			return err<ShellExecResult, ExecutionError>(e);
		}
		if (context.abortSignal?.aborted) {
			await this.guestRm([spill, rcpath]);
			return err<ShellExecResult, ExecutionError>(
				new PiExecutionError("aborted", "command aborted"),
			);
		}
		if (result.truncated || result.exitCode !== 0) {
			await this.guestRm([spill, rcpath]);
			return err<ShellExecResult, ExecutionError>(
				new PiExecutionError(
					"spawn_error",
					`sandbox shell failed (exit ${result.exitCode ?? "truncated"}): ${result.stderr.trim().slice(0, 500)}`,
				),
			);
		}
		// The rc file must parse or nothing is claimed.
		const rc = await this.run(["cat", "--", rcpath], undefined, context);
		const rcText = rc.stdout.trim();
		const exitCode = /^[0-9]{1,3}$/.test(rcText) ? Number(rcText) : NaN;
		if (
			rc.timedOut ||
			rc.truncated ||
			rc.exitCode !== 0 ||
			!Number.isInteger(exitCode) ||
			exitCode < 0 ||
			exitCode > 255
		) {
			await this.guestRm([spill, rcpath]);
			return err<ShellExecResult, ExecutionError>(
				new PiExecutionError(
					"unknown",
					`command exit code was not recorded (rc file: ${JSON.stringify(rcText.slice(0, 60))})`,
				),
			);
		}
		const wc = await this.run(["wc", "-l", "-c", "--", spill], undefined, context);
		const wcFields = wc.stdout.trim().split(/\s+/).map(Number);
		const lines = wcFields[0];
		const bytes = wcFields[1];
		if (
			wc.timedOut ||
			wc.truncated ||
			wc.exitCode !== 0 ||
			lines === undefined ||
			bytes === undefined ||
			!Number.isInteger(lines) ||
			!Number.isInteger(bytes) ||
			lines < 0 ||
			bytes < 0
		) {
			await this.guestRm([spill, rcpath]);
			return err<ShellExecResult, ExecutionError>(
				new PiExecutionError(
					"unknown",
					"command output could not be measured — result not claimed complete",
				),
			);
		}
		if (exitCode === 153) {
			// 128+SIGXFSZ: `ulimit -f` caps EVERY file this command writes,
			// not just the spill — a legitimate large artifact dies as a
			// bare 153 unless the explanation always rides along. The
			// spill-sized case stays a hard error: nothing is claimed.
			if (bytes >= SPILL_CAP_BYTES) {
				await this.guestRm([spill, rcpath]);
				return err<ShellExecResult, ExecutionError>(
					new PiExecutionError(
						"unknown",
						`command output exceeded the ${SPILL_CAP_BYTES / (1024 * 1024)} MiB wall — killed by ulimit, output not claimed`,
					),
				);
			}
			options?.onOutput?.(
				`[goblin] exit 153: a file write exceeded the sandbox's ${SPILL_CAP_BYTES / (1024 * 1024)} MiB per-file cap (SIGXFSZ) — produce large artifacts in chunks or stream them\n`,
				context,
			);
		}
		const afterBytes = options?.spill?.afterBytes ?? 100 * 1024;
		const afterLines = options?.spill?.afterLines ?? 2_000;
		if (bytes > afterBytes || lines > afterLines) {
			const tail = await this.run(
				["tail", "-c", String(SPILL_TAIL_BYTES), "--", spill],
				{ maxOutput: SPILL_TAIL_BYTES + 4096 },
				context,
			);
			if (tail.timedOut || tail.exitCode !== 0 || tail.truncated) {
				await this.guestRm([spill, rcpath]);
				return err<ShellExecResult, ExecutionError>(
					new PiExecutionError(
						"unknown",
						"output spilled but its tail could not be read back — result not claimed",
					),
				);
			}
			options?.onOutput?.(
				`[goblin] output exceeded ${afterBytes} bytes/${afterLines} lines — tail follows; full output at ${spill}\n`,
				context,
			);
			options?.onOutput?.(tail.stdout, context);
			// The advertised file is retained; only the rc file goes.
			const rcRm = await this.guestRm([rcpath]);
			if (rcRm !== null) {
				const e = new PiExecutionError(
					"unknown",
					`command rc-file cleanup failed: ${rcRm} — spilled output remains at ${spill}`,
				);
				e.spillPath = spill;
				return err<ShellExecResult, ExecutionError>(e);
			}
			return ok<ShellExecResult, ExecutionError>({ exitCode, spillPath: spill });
		}
		const out = await this.run(["cat", "--", spill], { maxOutput: afterBytes + 4096 }, context);
		if (out.timedOut || out.exitCode !== 0 || out.truncated) {
			await this.guestRm([spill, rcpath]);
			return err<ShellExecResult, ExecutionError>(
				new PiExecutionError(
					"unknown",
					"command output could not be read back — result not claimed complete",
				),
			);
		}
		options?.onOutput?.(out.stdout, context);
		const rm = await this.guestRm([spill, rcpath]);
		if (rm !== null) {
			return err<ShellExecResult, ExecutionError>(
				new PiExecutionError("unknown", `command output cleanup failed: ${rm}`),
			);
		}
		return ok<ShellExecResult, ExecutionError>({ exitCode });
	}
	async cleanup(): Promise<void> {}
}

// Test seam: the real sandbox-backed ExecutionEnv for direct
// conformance checks — production reaches the same class only
// through openSubagents' env hook.
export function makeSandboxEnv(
	sandboxes: Sandboxes,
	transferRoot: string,
	origin: string,
): ExecutionEnv {
	return new SandboxEnv(sandboxes, transferRoot, origin);
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

	// ---------- tool wrappers ----------

	// Terminal-outcome wrap: once a terminal tool committed the doc,
	// every other tool in the bundled round returns terminate WITHOUT
	// running — `terminate` only ends the round when every call
	// terminates, so a blocked call would keep the round alive; this
	// satisfies it while keeping the side effect out.
	function withTerminalWrap<T extends ToolRegistration>(tool: T): T {
		const inner = tool.execute;
		return {
			...tool,
			execute: async (args: never, api: ToolExecutionApi, context: Context) => {
				const doc = await api.snapshot(RunDoc, api.conversationId, context);
				if (doc?.outcome !== undefined && doc?.outcome !== null) {
					return {
						control: { terminate: true },
						content: [
							{
								type: "text" as const,
								text: "this run already recorded a terminal outcome — the action was not performed",
							},
						],
					};
				}
				return inner(args, api, context);
			},
		} as T;
	}

	// Every worker tool result carries the latest destructive sandbox
	// lifecycle note as a diagnostic — recorded through api.diagnostic
	// in a finally so a timeout or nonzero/error path carries it too,
	// alongside whatever output the tool already streamed. Repeat
	// until replaced, never a clear-before-result gap.
	function withLifecycleNote<T extends ToolRegistration>(tool: T): T {
		const inner = tool.execute;
		return {
			...tool,
			execute: async (args: never, api: ToolExecutionApi, context: Context) => {
				try {
					return await inner(args, api, context);
				} finally {
					const note = rowForConversation(String(api.conversationId))?.lifecycleNote;
					if (note !== undefined && note !== null && note !== "") {
						try {
							api.diagnostic({ severity: "warn", message: note, code: "lifecycle" });
						} catch (err) {
							log.warn("lifecycle diagnostic could not be recorded", err);
						}
					}
				}
			},
		} as T;
	}

	// Every run-scoped tool passes the liveness gate first: the row
	// exists, the run is executing, no stop intent is persisted, and
	// the owner is open.
	function withRunGuards<T extends ToolRegistration>(tool: T): T {
		const inner = tool.execute;
		return {
			...tool,
			execute: async (args: never, api: ToolExecutionApi, context: Context) => {
				const row = requireRow(api);
				requireLive(row);
				return inner(args, api, context);
			},
		} as T;
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

	// Computer tools also renew the desktop controller lease before
	// touching the box — observation and input alike; acting under
	// someone else's lease is impossible.
	function withLeaseRenew<T extends ToolRegistration>(tool: T): T {
		const inner = tool.execute;
		return {
			...tool,
			execute: async (args: never, api: ToolExecutionApi, context: Context) => {
				const row = requireRow(api);
				const claimed = await deps.desktops.claim(row.desktop!, holderFor(row.id));
				persistClaimNote(row.id, claimed.note);
				// The claim await is a cancellation window — stop intent can
				// persist while it pends, and the entry row is stale. Re-gate
				// on a fresh read immediately before dispatch.
				requireLive(requireRow(api));
				if (context.abortSignal?.aborted) {
					throw new SubagentError(
						`run #${row.id} was cancelled during lease acquisition — the action was not performed`,
					);
				}
				return inner(args, api, context);
			},
		} as T;
	}

	// ---------- the crash-approval gate ----------

	// In-memory waiters and pre-registered decisions, keyed by
	// piConv:piTaskId. A parked gate resolves on decide(); a decide()
	// landing before the gate's post-restart re-entry is consumed by the
	// next park instead of re-asking. Both maps die with the owner —
	// waiters reject on the invocation's abort at close, and a parked
	// row re-parks from the durable lease on the next boot.
	const approvalWaiters = new Map<string, (decision: SubagentApprovalDecision) => void>();
	const approvalDecisions = new Map<string, SubagentApprovalDecision>();
	const approvalKey = (piConversationId: string, piTaskId: string) =>
		`${piConversationId}:${piTaskId}`;
	function dropApprovalState(piConversationId: string): void {
		const prefix = `${piConversationId}:`;
		for (const key of [...approvalDecisions.keys()]) {
			if (key.startsWith(prefix)) approvalDecisions.delete(key);
		}
		for (const key of [...approvalWaiters.keys()]) {
			if (key.startsWith(prefix)) approvalWaiters.delete(key);
		}
	}

	function approvalQuestion(request: {
		tool: string;
		callId: string;
		args: unknown;
		attempts: number;
	}): string {
		let argsText: string;
		try {
			argsText = JSON.stringify(request.args) ?? "null";
		} catch {
			argsText = "[unserializable arguments]";
		}
		if (argsText.length > 4000) argsText = `${argsText.slice(0, 4000)}…`;
		return [
			`A ${request.tool} call was interrupted by a restart and may have partially run — whether its side effect landed is unknown.`,
			`tool: ${request.tool}\ncall: ${request.callId}\nattempts: ${request.attempts}\narguments: ${argsText}`,
			`decide with record-result (supply the call's observed result), authorize-retry (run it once more), or abandon (end the run).`,
		].join("\n\n");
	}

	// The approval host is the gate's operator surface. Parking writes
	// the run needs_input plus the pendingApproval mirror and notice —
	// the same routing surface ask_operator uses — then waits on
	// decide(), raced against the invocation's abort so a stopped or
	// closing run ends the wait instead of hanging waitForIdle. The
	// host deliberately never takes the run lane: completeStop joins
	// the Pi conversation that is waiting here, so a lane-held park
	// would deadlock the stop.
	const approvalHost = {
		async requestApproval(
			request: {
				conversationId: string;
				taskId: string;
				callId: string;
				tool: string;
				args: unknown;
				attempts: number;
			},
			context: Context,
		): Promise<SubagentApprovalDecision> {
			const key = approvalKey(request.conversationId, request.taskId);
			const queued = approvalDecisions.get(key);
			if (queued !== undefined) {
				// decide() ran before this task re-entered the gate — the
				// post-restart window. Apply the stored decision instead of
				// asking again.
				approvalDecisions.delete(key);
				log.info("subagent approval: stored decision applied on gate re-entry", {
					piConversation: request.conversationId,
					piTaskId: request.taskId,
					tool: request.tool,
					callId: request.callId,
					kind: queued.kind,
				});
				return queued;
			}
			const row = rowForConversation(request.conversationId);
			if (row === null) {
				throw new SubagentError("approval request on an unknown subagent conversation");
			}
			if (
				row.stopRequested ||
				row.status === "stopped" ||
				row.status === "done" ||
				row.status === "failed"
			) {
				// Stop or settle won the race — the invocation's own abort
				// lands next; refuse to stand the wait up at all.
				throw new SubagentError(
					`run #${row.id} is ${row.stopRequested ? "stopping" : row.status} — no approval is parked`,
				);
			}
			if (row.status === "queued" && row.pendingApproval?.decision !== undefined) {
				// The verdict is durable on the row and the run waits only
				// for a global slot — re-parking would clobber it. The
				// scheduler's grant resolves this wait; the invocation's
				// abort still ends it on a stop or close.
				try {
					return await awaitWithContext(
						new Promise<SubagentApprovalDecision>((resolve) => {
							approvalWaiters.set(key, resolve);
						}),
						context,
					);
				} finally {
					approvalWaiters.delete(key);
				}
			}
			// needs_input frees the run's global slot, and for a computer
			// run the desktop controller lease releases — the same rules
			// as an ask_operator park. The write is idempotent across
			// re-entries: a crash between the operator's decision and its
			// lease commit re-parks the same ask.
			let parked: SubagentRun;
			try {
				parked = runs.update(row.id, {
					status: "needs_input",
					question: approvalQuestion(request),
					pendingApproval: {
						piTaskId: request.taskId,
						callId: request.callId,
						tool: request.tool,
						args: request.args,
						attempts: request.attempts,
					},
				});
			} catch (err) {
				// A park the store can't record must NOT become an ordinary
				// tool error — the model would retry the interrupted side
				// effect with no operator decision behind it. Persisted
				// stop intent fences every later tool re-entry (requireLive
				// refuses a stopping row), the fired abort ends this
				// invocation, and the scan's pendingStops completes the
				// terminal mark. When even the intent can't land, a direct
				// 'failed' mark is the last fence a retry can hit.
				log.error("crash-approval park could not persist — fencing the run", err, {
					run: row.id,
					tool: request.tool,
					callId: request.callId,
				});
				try {
					runs.update(row.id, { stopRequested: true });
				} catch (e) {
					log.warn("stop intent could not persist after the failed park", e, { run: row.id });
					try {
						runs.update(row.id, {
							status: "failed",
							error: "the approval park could not persist — the interrupted call's effect is unobserved",
							noticePending: true,
							finishedAt: Date.now(),
						});
					} catch (e2) {
						log.warn("the failed-park fence could not settle the row either", e2, {
							run: row.id,
						});
					}
				}
				if (row.piConversationId !== null && !harnessClosed) {
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
				}
				throw new SubagentError(
					`run #${row.id} approval park could not persist — the run is fenced`,
				);
			}
			releaseLeases(parked);
			log.info("subagent parked on a crash-ambiguous tool call", {
				run: row.id,
				piTaskId: request.taskId,
				tool: request.tool,
				callId: request.callId,
				attempts: request.attempts,
			});
			notify(parked);
			// The parked row just freed its slot — admit whoever is queued.
			scheduleDrain();
			try {
				return await awaitWithContext(
					new Promise<SubagentApprovalDecision>((resolve) => {
						approvalWaiters.set(key, resolve);
					}),
					context,
				);
			} finally {
				approvalWaiters.delete(key);
			}
		},
	};

	// The crash-approval gate (design/subagents.md → Crash approval).
	// replay:"safe" is deliberate and NOT an idempotency claim: it is
	// the only re-entry point pi-durable offers — recovery re-executes
	// replay-safe tool tasks — and re-entry lands here. Re-entry on a
	// `claimed` lease parks the run for an operator decision; on a
	// `done` lease it replays the recorded result without re-executing.
	// This wrapper sits OUTSIDE withRunGuards: a parked row is
	// needs_input, which requireLive rejects — inside the guards the
	// re-entry could never reach the gate.
	function withApprovalGate<T extends ToolRegistration>(tool: T): T {
		const inner = tool.execute;
		const name = tool.name;
		return {
			...tool,
			replay: "safe",
			execute: async (args: never, api: ToolExecutionApi, context: Context) => {
				const lease = readApprovalLease(
					await api.snapshot(approvalLeaseDoc, api.taskId, context),
				);
				if (lease?.state === "done") {
					return lease.result as ToolExecutionResult;
				}
				// Claim generations survive decisions — a retry that itself
				// dies mid-flight re-asks with the raised count.
				const prior = approvalLeaseGeneration(lease);
				let decision = prior.decision;
				if (decision === undefined && lease?.state === "claimed") {
					// The ambiguity: dispatch committed, result absent, effect
					// unobserved. Park — nothing model-facing happens until the
					// operator decides.
					api.output(
						`⏸ ${name} was interrupted and may have partially run — awaiting an operator decision`,
					);
					decision = await approvalHost.requestApproval(
						{
							conversationId: String(api.conversationId),
							taskId: String(api.taskId),
							callId: api.callId,
							tool: name,
							args,
							attempts: prior.attempts,
						},
						context,
					);
				}
				if (decision !== undefined) {
					// The decision commits BEFORE acting on it — a crash in
					// between leaves `claimed` and the gate re-asks on the
					// next boot.
					await commitApprovalLease(
						api,
						approvalDecidedRow(prior.attempts, asJson(decision)),
						context,
					);
				}
				if (decision !== undefined && decision.kind === "record-result") {
					if (decision.result === undefined || decision.result === "") {
						throw new SubagentError(
							"record-result decision without result text — the lease is inconsistent",
						);
					}
					const result = {
						content: [
							{
								type: "text" as const,
								text: decision.result,
							},
						],
						diagnostics: [
							{
								severity: "warn" as const,
								code: "operator_recorded",
								message: `this result was recorded by the operator for an interrupted ${name} call${decision.note === undefined ? "" : ` — operator note: ${decision.note}`}`,
							},
						],
					} satisfies ToolExecutionResult;
					await commitApprovalLease(api, approvalDoneRow(asJson(result)), context);
					return result;
				}
				if (decision !== undefined && decision.kind === "abandon") {
					const reason = `the operator abandoned the run after an interrupted ${name} call — the call's effect is unobserved${decision.note === undefined ? "" : ` — operator note: ${decision.note}`}`;
					await recordOutcome(api, { kind: "aborted", reason });
					return {
						content: [
							{
								type: "text" as const,
								text: `The operator ended this run after an interrupted ${name} call; the call's effect is unobserved.${decision.note === undefined ? "" : ` Operator note: ${decision.note}`}`,
							},
						],
						control: { terminate: true },
					} satisfies ToolExecutionResult;
				}
				// Fresh call, or an authorized re-execution. Either way the
				// gate admits exactly one dispatch under this generation.
				await commitApprovalLease(api, approvalClaimRow(prior.attempts + 1), context);
				// The lease must replay the result the model actually saw —
				// Pi folds streamed output(), diagnostic() and details()
				// calls into the resolved result when the return value
				// omits them (bash returns {} and streams stdout/stderr).
				// Persisting the raw return would replay "(no tool
				// output)" after a restart, so the durable row carries the
				// effective result instead.
				const capturedOutput: string[] = [];
				const capturedDiagnostics: ToolDiagnostic[] = [];
				let capturedDetails: JsonValue | undefined;
				const decoder = new TextDecoder();
				const observed: ToolExecutionApi = {
					...api,
					output(chunk) {
						capturedOutput.push(
							typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
						);
						api.output(chunk);
					},
					diagnostic(d) {
						capturedDiagnostics.push(d);
						api.diagnostic(d);
					},
					async details(v, ctx) {
						capturedDetails = v as JsonValue;
						await api.details(v, ctx);
					},
				};
				const result = await inner(args, observed, context);
				const tail = decoder.decode();
				if (tail !== "") capturedOutput.push(tail);
				const effective: ToolExecutionResult = {
					...(result.content === undefined && capturedOutput.length > 0
						? {
								content: [{ type: "text" as const, text: capturedOutput.join("") }],
							}
						: {}),
					...result,
					...(result.details === undefined && capturedDetails !== undefined
						? { details: capturedDetails }
						: {}),
					diagnostics: [...capturedDiagnostics, ...(result.diagnostics ?? [])],
				};
				await commitApprovalLease(api, approvalDoneRow(asJson(effective)), context);
				// The settled tool-result replay and the model-facing
				// result both come from this return — the lease doc
				// itself retires with the tool task, so it can only
				// cover a crash inside the call's own window.
				return effective;
			},
		} as T;
	}

	// ---------- tools ----------

	const finishParams = Type.Object({
		result: Type.String({
			description: SUBAGENT_PARAMETER_DESCRIPTIONS.result,
			minLength: 1,
			maxLength: MAX_RESULT_CHARS,
		}),
		files: Type.Optional(
			Type.Array(Type.String({ pattern: "^/" }), {
				description: SUBAGENT_PARAMETER_DESCRIPTIONS.files,
				maxItems: MAX_INPUT_FILES,
			}),
		),
	});
	const askParams = Type.Object({
		question: Type.String({
			description: SUBAGENT_PARAMETER_DESCRIPTIONS.question,
			minLength: 1,
			maxLength: MAX_MESSAGE_CHARS,
		}),
	});

	const finishTool = defineTool({
		name: "finish",
		description: FINISH_TOOL_DESCRIPTION,
		parameters: finishParams,
		replay: "safe",
		execute: async (args, api, context) => {
			requireLive(requireRow(api));
			const files = args.files ?? [];
			if (files.length > MAX_INPUT_FILES || files.some((f) => !f.startsWith("/"))) {
				throw new SubagentError(
					`finish files must be at most ${MAX_INPUT_FILES} absolute box paths`,
				);
			}
			await recordOutcome(api, { kind: "done", result: args.result, files });
			return {
				control: { terminate: true },
				content: [{ type: "text", text: "run finished" }],
			};
		},
	});
	const askTool = defineTool({
		name: "ask_operator",
		description: ASK_OPERATOR_TOOL_DESCRIPTION,
		parameters: askParams,
		replay: "safe",
		execute: async (args, api, context) => {
			requireLive(requireRow(api));
			await recordOutcome(api, { kind: "ask", question: args.question });
			return {
				control: { terminate: true },
				content: [{ type: "text", text: "question recorded — the run pauses until answered" }],
			};
		},
	});

	// Side-effecting tools (write/edit/bash) get the crash-approval gate
	// outside the run guards; read stays observation-only and replay-safe,
	// and the terminal tools are ungated — gating them would recurse the
	// approval machinery into the very calls that record outcomes.
	const workerTools: ToolRegistration[] = [
		withLifecycleNote(
			withTerminalWrap(withRunGuards({ ...createReadTool(), replay: "safe" as const })),
		),
		withLifecycleNote(withApprovalGate(withTerminalWrap(withRunGuards(createWriteTool())))),
		withLifecycleNote(withApprovalGate(withTerminalWrap(withRunGuards(createEditTool())))),
		withLifecycleNote(
			withApprovalGate(
				withTerminalWrap(
					withRunGuards({ ...createBashTool(), description: WORKER_BASH_DESCRIPTION }),
				),
			),
		),
		finishTool,
		askTool,
	];

	const computerTools: ToolRegistration[] = [
		defineTool({
			name: "screenshot",
			description: COMPUTER_TOOL_DESCRIPTIONS.screenshot,
			parameters: Type.Object({}),
			replay: "safe",
			execute: async (_args, api) => {
				const row = requireRow(api);
				const shot = await deps.desktops.screenshot(row.desktop!);
				return {
					content: [
						{
							type: "text",
							text: `observation_id: ${shot.id}\naudited path: ${shot.path}${shot.note ? `\n${shot.note}` : ""}`,
						},
						{
							type: "image",
							data: Buffer.from(shot.bytes).toString("base64"),
							mimeType: "image/png",
						},
					],
				};
			},
		}),
		defineTool({
			name: "inspect",
			description: COMPUTER_TOOL_DESCRIPTIONS.inspect,
			parameters: Type.Object({
				pid: Type.Optional(Type.Number()),
				window_id: Type.Optional(Type.Number()),
			}),
			replay: "safe",
			execute: async (args, api) => {
				const row = requireRow(api);
				const ins = await deps.desktops.inspect(row.desktop!, {
					...(args.pid !== undefined ? { pid: args.pid } : {}),
					...(args.window_id !== undefined ? { windowId: args.window_id } : {}),
				});
				// The state may carry a base64 frame — it is image data,
				// not text: strip it from the JSON and emit it as an inline
				// image block so a dump can't crowd out the tree.
				const raw: unknown = ins.state;
				const stateObj: Record<string, unknown> =
					typeof raw === "object" && raw !== null
						? { ...(raw as Record<string, unknown>) }
						: { state: raw };
				let image: { type: "image"; data: string; mimeType: string } | null = null;
				const shot = stateObj["screenshot_png_b64"] ?? stateObj["screenshot"];
				if (typeof shot === "string" && shot.length > 0) {
					image = { type: "image", data: shot, mimeType: "image/png" };
				}
				delete stateObj["screenshot_png_b64"];
				delete stateObj["screenshot"];
				const state = stateObj;
				const text = JSON.stringify(state);
				const content: NonNullable<ToolExecutionResult["content"]> = [
					{
						type: "text",
						text:
							`observation_id: ${ins.id}${ins.note ? `\n${ins.note}` : ""}\n` +
							(text.length > INSPECT_STATE_CAP
								? `${text.slice(0, INSPECT_STATE_CAP)}\n[state truncated at ${INSPECT_STATE_CAP} chars]`
								: text),
					},
				];
				if (image !== null) content.push(image);
				return { content };
			},
		}),
		defineTool({
			name: "act",
			description: COMPUTER_TOOL_DESCRIPTIONS.act,
			parameters: Type.Object({
				observation_id: Type.String(),
				tool: Type.String({ description: SUBAGENT_PARAMETER_DESCRIPTIONS.cuaTool }),
				args: Type.Record(Type.String(), Type.Unknown()),
			}),
			execute: async (args, api) => {
				const row = requireRow(api);
				if (!CUA_TOOLS.has(args.tool)) {
					throw new SubagentError(
						`act tool ${JSON.stringify(args.tool)} is not an allowed input operation`,
					);
				}
				const holder = holderFor(row.id);
				const out = await deps.desktops.act(row.desktop!, holder, args.observation_id, {
					kind: "cua",
					tool: args.tool as CuaTool,
					args: args.args,
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(out.result) + (out.note ? `\n${out.note}` : ""),
						},
					],
				};
			},
		}),
		defineTool({
			name: "launch",
			description: COMPUTER_TOOL_DESCRIPTIONS.launch,
			parameters: Type.Object({
				observation_id: Type.String(),
				url: Type.Optional(Type.String()),
			}),
			execute: async (args, api) => {
				const row = requireRow(api);
				const holder = holderFor(row.id);
				const out = await deps.desktops.act(row.desktop!, holder, args.observation_id, {
					kind: "launch",
					app: "chromium",
					...(args.url !== undefined ? { url: args.url } : {}),
				});
				return {
					content: [
						{ type: "text", text: JSON.stringify(out.result) + (out.note ? `\n${out.note}` : "") },
					],
				};
			},
		}),
		finishTool,
		askTool,
	];

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
			// persisted mid-execute still reaches this call's result. The
			// input tools (act/launch) are side-effecting and get the
			// crash-approval gate outside the run guards; screenshot and
			// inspect are observations — replay-safe, ungated.
			if (t.name === "act" || t.name === "launch") {
				return withLifecycleNote(
					withApprovalGate(withRunGuards(withLeaseRenew(withTerminalWrap(t)))),
				);
			}
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

	// ---------- files in/out ----------

	async function importFiles(row: SubagentRun): Promise<string[]> {
		const requested = row.files;
		if (requested.length === 0) return [];
		const dirTag = `run-${row.id}`;
		const stageDir = join(deps.transferRoot, dirTag);
		mkdirSync(stageDir, { recursive: true });
		const inbox: string[] = [];
		const errors: string[] = [];
		try {
			for (const [i, f] of requested.entries()) {
				throwIfHalted(row.id);
				const resolved = readImport(row.workspace, f);
				if ("error" in resolved) {
					errors.push(`${f}: ${resolved.error}`);
					continue;
				}
				const base = `${String(i + 1).padStart(2, "0")}-${basename(resolved.path)}`;
				const staged = join(stageDir, base);
				writeFileSync(staged, resolved.data);
				throwIfHalted(row.id);
				const dest =
					row.kind === "computer"
						? `/home/desk/inbox/subagents/${row.id}/${base}`
						: `/inbox/subagents/${row.id}/${base}`;
				if (row.kind === "computer") {
					await deps.desktops.cpIn(row.desktop!, staged, dest);
				} else {
					const mk = await deps.sandboxes.execArgv(
						row.conversationId,
						["mkdir", "-p", "--", posix.dirname(dest)],
						{ timeoutMs: 30_000, maxOutput: 64 * 1024 },
					);
					if (mk.result.timedOut || mk.result.truncated || mk.result.exitCode !== 0) {
						throw new SubagentError(
							`inbox directory could not be created: ${mk.result.stderr.trim().slice(0, 200)}`,
						);
					}
					throwIfHalted(row.id);
					await deps.sandboxes.cpIn(row.conversationId, staged, dest);
				}
				throwIfHalted(row.id);
				inbox.push(dest);
			}
		} finally {
			rmSync(stageDir, { recursive: true, force: true });
		}
		if (errors.length > 0) {
			throw new SubagentError(`import refused: ${errors.join("; ")}`);
		}
		return inbox;
	}

	// Deterministic numbered basenames under the run's own dir, progress
	// persisted per source so a restart reuses landed artifacts instead
	// of recopying box files that may have changed.
	async function exportOutcomeFiles(
		row: SubagentRun,
		files: string[],
	): Promise<{ exported: string[]; errors: string[] }> {
		const relDir = join("subagents", String(row.id));
		for (const [i, f] of files.entries()) {
			// A stop mid-export lands between files — landed artifacts
			// stay recorded, the rest are simply not copied.
			const latest = runs.get(row.id);
			if (
				closing ||
				harnessClosed ||
				latest === null ||
				latest.stopRequested ||
				latest.status === "stopped"
			) {
				break;
			}
			if (row.exportProgress[f] !== undefined) continue;
			const source = f;
			if (!f.startsWith("/")) {
				row = runs.recordExport(row.id, source, {
					error: `${f}: export paths must be absolute box paths`,
				});
				continue;
			}
			let outcome: { rel: string } | { error: string };
			try {
				const data =
					row.kind === "computer"
						? (await deps.desktops.catFile(row.desktop!, f)).data
						: (await deps.sandboxes.catFile(row.conversationId, f)).data;
				const name = `${String(i + 1).padStart(2, "0")}-${basename(f)}`;
				const out = exportNamedBytes(row.workspace, relDir, name, data);
				outcome = "error" in out ? { error: `${f}: ${out.error}` } : { rel: out.rel };
			} catch (err) {
				// Only the export boundary's own typed refusals are
				// model-visible outcomes — an unexpected host/storage
				// error is a failed settle, not a fabricated refusal: it
				// propagates so the run stays owned and monitor recovery
				// retries the durable export later.
				if (
					err instanceof DesktopError ||
					err instanceof SandboxError ||
					err instanceof PodmanError
				) {
					outcome = { error: `${f}: ${err.message}` };
				} else {
					throw err;
				}
			}
			row = runs.recordExport(row.id, source, outcome);
		}
		const exported: string[] = [];
		const errors: string[] = [];
		for (const f of files) {
			const p = row.exportProgress[f];
			if (p === undefined) continue;
			if ("rel" in p) exported.push(p.rel);
			else errors.push(p.error);
		}
		return { exported, errors };
	}

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
				return row.pendingApproval !== null
					? `Approval needed — a restarted ${row.pendingApproval.tool} call may have partially run:\n${row.question ?? ""}`
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
			if (row.piConversationId !== null) dropApprovalState(row.piConversationId);
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
					// decide() writes the verdict and queues in one update —
					// an empty one is a wedged row, not a slot to burn.
					retryAfter.set(row.id, Date.now() + LEASE_RETRY_MS);
					return { kind: "blocked", reason: "no persisted approval decision" };
				}
				const key = approvalKey(fresh.piConversationId, fresh.pendingApproval.piTaskId);
				runs.update(row.id, { status: "running", pendingApproval: null });
				const waiter = approvalWaiters.get(key);
				if (waiter === undefined) {
					// No invocation is waiting — the gate re-enters on
					// harness.resume().
					approvalDecisions.set(key, d);
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
				if (!monitored(row.id) && fresh.piSubmissionId !== null) {
					const sub = await harness.submission(asSub(fresh.piSubmissionId), ctx);
					if (sub !== undefined) monitor(row.id, fresh.inputRev, sub);
				}
				if (waiter !== undefined) {
					approvalWaiters.delete(key);
					waiter(d);
				} else if (resumed && !harnessClosed) {
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
			if (afterCancel.piConversationId !== null) dropApprovalState(afterCancel.piConversationId);
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
				if (row.pendingApproval !== null) {
					// A parked approval is not a question the model may
					// answer — a queued/steered message would sit behind a
					// tool task that only an operator decision resolves.
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
		async decide(id, conv, decision) {
			if (closing) throw new SubagentError("subagents are closed");
			const parsed = approvalDecisionSchema.safeParse(decision);
			if (!parsed.success) {
				throw new SubagentError(`invalid approval decision: ${parsed.error.message}`);
			}
			const d = parsed.data;
			if (
				d.kind === "record-result" &&
				(d.result === undefined || d.result.length === 0)
			) {
				throw new SubagentError(
					"record-result needs result text — the model sees it as the call's output",
				);
			}
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
				const updated = runs.update(id, {
					status: "queued",
					pendingApproval: { ...pending, decision: d },
				});
				log.info("subagent approval decided — queued for admission", {
					run: id,
					piTaskId: pending.piTaskId,
					tool: pending.tool,
					callId: pending.callId,
					kind: d.kind,
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
					// needs_input waits on the operator; queued carries a
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
