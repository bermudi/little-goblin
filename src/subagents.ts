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

import { mkdirSync, rmSync, statSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
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
import type { Desktops, CuaTool, LeaseHolder } from "./desktops.ts";
import type { Sandboxes } from "./sandboxes.ts";
import {
	MAX_INPUT_FILES,
	MAX_MESSAGE_CHARS,
	MAX_RESULT_CHARS,
	MAX_TASK_CHARS,
	type InputMode,
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
import { BOX_FILE_MAX_BYTES, exportNamedBytes, resolveImport } from "./box-files.ts";
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
	| { kind: "ask"; question: string };
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
	 *  wake can run. Call once after every dep is bound. */
	resume(): Promise<void>;
	/** Pause admission and the ticker, join in-flight operations, then
	 *  close the harness — pending runs persist; nothing is aborted on
	 *  shutdown. */
	close(): Promise<void>;
}

const CUA_TOOLS: ReadonlySet<string> = new Set([
	"click",
	"double_click",
	"right_click",
	"press_key",
	"hotkey",
	"type_text",
	"scroll",
	"drag",
	"set_value",
	"bring_to_front",
	"invoke_menu",
	"set_window_frame",
]);

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
function procError(stderr: string, path: string): ConstructorParameters<typeof FileError>[0] {
	if (/no such|cannot stat|not found/i.test(stderr)) return "not_found";
	if (/Permission denied/i.test(stderr)) return "permission_denied";
	if (/Not a directory/i.test(stderr)) return "not_directory";
	if (/Is a directory/i.test(stderr)) return "is_directory";
	return "unknown";
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
	private check(
		r: {
			stdout: string;
			stderr: string;
			exitCode: number | null;
			timedOut: boolean;
			truncated: boolean;
		},
		path?: string,
	): Result<void, FileError> {
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
				procError(r.stderr, path ?? ""),
				`${path ?? "command"}: ${r.stderr.trim()}`,
				path,
			);
		}
		return ok<void, FileError>(undefined);
	}
	private async runOut(
		argv: string[],
		path: string,
		context: Context,
	): Promise<Result<string, FileError>> {
		const r = await this.run(argv, undefined, context);
		const bad = this.check(r, path);
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
			return envErr(procError(result.stderr, path), `${path}: ${result.stderr.trim()}`, path);
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
		// cpIn into the guest, an in-guest shell op moves it. The guest
		// stage is removed inside the same script, success or failure.
		mkdirSync(this.transferRoot, { recursive: true });
		const staged = join(
			this.transferRoot,
			`w-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		);
		await Bun.write(staged, content);
		try {
			if (context.abortSignal?.aborted) return aborted();
			const guest = `${STAGE}-${Math.random().toString(16).slice(2)}`;
			await this.sandboxes.cpIn(this.origin, staged, guest);
			if (context.abortSignal?.aborted) return aborted();
			const r = await this.run(
				["/bin/sh", "-c", destScript, "env", guest, this.resolve(path)],
				undefined,
				context,
			);
			const bad = this.check(r, path);
			if (!bad.ok) return bad;
			return ok<void, FileError>(undefined);
		} finally {
			rmSync(staged, { force: true });
		}
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
		return this.check(r, path);
	}
	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		const r = await this.run(["sync"], undefined, context);
		const bad = this.check(r, path);
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
		return this.check(r, sourcePath);
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
		return this.check(r, path);
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
		return this.check(r, path);
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
	private async guestRm(paths: string[]): Promise<void> {
		try {
			const { result } = await this.sandboxes.execArgv(this.origin, ["rm", "-f", "--", ...paths], {
				timeoutMs: 15_000,
				maxOutput: 64 * 1024,
			});
			if (result.timedOut || result.exitCode !== 0) {
				log.warn("sandbox env cleanup failed", {
					paths: paths.length,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
				});
			}
		} catch (e) {
			log.warn("sandbox env cleanup failed", e, { paths: paths.length });
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
		if (bytes >= SPILL_CAP_BYTES && exitCode === 153) {
			await this.guestRm([spill, rcpath]);
			return err<ShellExecResult, ExecutionError>(
				new PiExecutionError(
					"unknown",
					`command output exceeded the ${SPILL_CAP_BYTES / (1024 * 1024)} MiB wall — killed by ulimit, output not claimed`,
				),
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
			await this.guestRm([rcpath]);
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
		await this.guestRm([spill, rcpath]);
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
	// In-flight monitors and admissions — close joins them so a paused
	// run is left durable, never mutated after close.
	const monitorTasks = new Set<Promise<void>>();
	const recoveryPending = new Set<number>();

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

	// Computer tools also renew the desktop controller lease before
	// touching the box — observation and input alike; acting under
	// someone else's lease is impossible.
	function withLeaseRenew<T extends ToolRegistration>(tool: T): T {
		const inner = tool.execute;
		return {
			...tool,
			execute: async (args: never, api: ToolExecutionApi, context: Context) => {
				const row = requireRow(api);
				await deps.desktops.claim(row.desktop!, holderFor(row.id));
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

	const workerTools: ToolRegistration[] = [
		withLifecycleNote(
			withTerminalWrap(withRunGuards({ ...createReadTool(), replay: "safe" as const })),
		),
		withLifecycleNote(withTerminalWrap(withRunGuards(createWriteTool()))),
		withLifecycleNote(withTerminalWrap(withRunGuards(createEditTool()))),
		withLifecycleNote(
			withTerminalWrap(
				withRunGuards({ ...createBashTool(), description: WORKER_BASH_DESCRIPTION }),
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
	// land under the wrong holder. A committed terminal outcome also
	// stops generation: an unknown or malformed tool slot can leave a
	// round "unanswered", and the monitor settles the run from the doc.
	const requestGuard = hook(GenerationTask, {
		beforeRequest: async (_input, api, context) => {
			const doc = await api.snapshot(RunDoc, api.conversationId, context);
			const row =
				doc?.runId !== null && doc !== undefined && doc !== null
					? runs.get(doc.runId)
					: rowForConversation(String(api.conversationId));
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
					await deps.desktops.claim(row.desktop, holderFor(row.id));
				} catch (err) {
					log.warn("subagent lost its desktop lease — aborting the request", err, {
						run: row.id,
						desktop: row.desktop,
					});
					abortPiTask(api);
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
			return withRunGuards(withLeaseRenew(withTerminalWrap(t)));
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
				const resolved = resolveImport(row.workspace, f);
				if ("error" in resolved) {
					errors.push(`${f}: ${resolved.error}`);
					continue;
				}
				const base = `${String(i + 1).padStart(2, "0")}-${basename(resolved.path)}`;
				const staged = join(stageDir, base);
				await copyFile(resolved.path, staged);
				throwIfHalted(row.id);
				// The source may have grown between the boundary check
				// and the copy — the cap applies to what actually lands.
				const stagedSize = statSync(staged).size;
				if (stagedSize > BOX_FILE_MAX_BYTES) {
					errors.push(`${f}: exceeds the ${BOX_FILE_MAX_BYTES / (1024 * 1024)} MiB import cap`);
					continue;
				}
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
				outcome = {
					error: `${f}: ${err instanceof Error ? err.message : String(err)}`,
				};
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
				await conv?.abort(ctx);
			}
			const stopped = runs.update(id, { status: "stopped", finishedAt: Date.now() });
			log.info("subagent stopped", { run: id, kind: stopped.kind });
			releaseLeases(stopped);
			notify(stopped);
		});
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
			const row = runs.get(rowId);
			if (row === null) return;
			if (row.status === "stopped" || row.status === "done" || row.status === "failed") return;
			if (row.stopRequested) return; // the stop path owns the transition
			if (row.inputRev > rev || row.inputIntent !== null) return; // a newer input owns settlement
			if (closingNow()) return;
			if (row.piConversationId === null) {
				if (closingNow()) return;
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
			if (closingNow()) return;
			const recorded = doc?.outcome ?? null;
			// An outcome only settles the input it answered — a stale one
			// must never be attributed to a later submitted steer.
			const outcome = recorded !== null && recorded.rev === rev ? recorded : null;
			log.info("subagent settle", { run: rowId, outcome: outcome?.kind ?? null, unanswered });
			if (outcome?.kind === "done") {
				const { exported, errors } = await exportOutcomeFiles(row, outcome.files);
				if (closingNow()) return; // a close during export starts no new screenshot
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
						errors.push(`final screenshot: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				if (closingNow()) return;
				// Stop wins over a settlement that raced an export.
				const latest = runs.get(rowId)!;
				if (latest.stopRequested || latest.status === "stopped") return;
				const done = runs.update(rowId, {
					status: "done",
					result: outcome.result,
					exportedFiles: exported,
					exportErrors: errors,
					noticePending: true,
					finishedAt: Date.now(),
					lifecycleNote: null,
				});
				releaseLeases(done);
				notify(done);
			} else if (outcome?.kind === "ask") {
				if (closingNow()) return;
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
					if (closingNow()) return;
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
			} catch (err) {
				if (closing || harnessClosed) return;
				log.error("subagent monitor failed — the run stays owned for recovery", err, {
					run: rowId,
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

	// Admit's verdict distinguishes the two non-admissions callers
	// must answer differently: "halted" means stop/close owns the row,
	// while "blocked" is a lease conflict carrying the reason — a
	// caller that persisted an intent must roll it back or re-queue,
	// since drain only retries queued rows.
	type AdmitOutcome =
		| { kind: "admitted" }
		| { kind: "halted" }
		| { kind: "blocked"; reason: string };

	// One admission path for all three input modes: initial (task),
	// resume (needs_input answer) and steer (live input). Every step
	// re-checks the persisted row before the next external effect.
	async function admit(row: SubagentRun, preserveRunning = false): Promise<AdmitOutcome> {
		const t0 = Date.now();
		try {
			if (row.kind === "computer") {
				if (row.desktop === null) throw new SubagentError("computer run without a desktop");
				try {
					await deps.desktops.claim(row.desktop, holderFor(row.id));
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (preserveRunning) {
						log.warn("subagent steer claim rejected — the live run keeps the desktop", err, {
							run: row.id,
							desktop: row.desktop,
						});
						return { kind: "blocked", reason: msg };
					}
					if (/is controlled by/.test(msg)) {
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
			monitor(row.id, rev, submission);
			return { kind: "admitted" };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg === "stopped" || msg === "owner closing" || msg === "run row vanished") {
				return { kind: "halted" };
			}
			if (closing || runs.get(row.id)?.stopRequested === true) return { kind: "halted" };
			const failed = runs.update(row.id, {
				status: "failed",
				error: msg,
				noticePending: true,
				finishedAt: Date.now(),
			});
			releaseLeases(failed);
			notify(failed);
			return { kind: "halted" };
		}
	}

	// A blocked boot re-admit already armed the lease backoff drain
	// consults — re-queue so the retry actually happens. Dropping the
	// outcome here orphans the row the way send() did: a persisted
	// intent defers settlement forever, and a running row with no
	// monitor is never finalized — drain only retries queued rows.
	function queueBlockedReadmit(row: SubagentRun, outcome: AdmitOutcome): void {
		if (outcome.kind !== "blocked") return;
		runs.update(row.id, { status: "queued" });
		log.warn("subagent re-admit blocked by a held lease — queued for retry", {
			run: row.id,
			reason: outcome.reason,
		});
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
				// re-admit through the idempotent path.
				queueBlockedReadmit(row, await admit(row));
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
			// finds the admitted requestId or admits once.
			queueBlockedReadmit(row, await admit(row));
			return undefined;
		});
		if (rev !== undefined) await finalize(boot.id, rev);
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
				try {
					recoveryPending.delete(id);
					const row = runs.get(id);
					if (row === null || row.status !== "running" || row.stopRequested) continue;
					await recoverRun(row);
				} catch (err) {
					log.error("subagent recovery retry failed — stays pending", err, { run: id });
					recoveryPending.add(id);
				}
			}
			await drain();
		},
		async resume() {
			if (closing) throw new SubagentError("subagents are closed");
			if (resumed) return;
			resumed = true;
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
					await deps.desktops.claim(row.desktop, holderFor(row.id));
				} catch (err) {
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
			// Phase B — aborts (each enables Pi's scheduler, so every
			// row decision above is already persisted).
			for (const convId of leaseFailedConvs) {
				try {
					const conv = await harness.conversation(asConv(convId), ctx);
					await conv?.abort(ctx);
				} catch (err) {
					log.warn("lost-lease abort failed", err, { conversation: convId });
				}
			}
			for (const row of pendingStopRows) {
				try {
					await completeStop(row.id);
				} catch (err) {
					log.warn("subagent boot stop failed — stays pending", err, { run: row.id });
				}
			}
			for (const convId of liveConvs) {
				const row = runs.byPiConversation(convId);
				if (row !== null && row.status === "stopped") {
					try {
						const conv = await harness.conversation(asConv(convId), ctx);
						await conv?.abort(ctx);
						log.info("subagent boot aborted leftover work of a stopped run", { run: row.id });
					} catch (err) {
						log.warn("stopped run's leftover abort failed", err, { run: row.id });
					}
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
			// 5. Only now may scheduling, wakes and drains start.
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
