// Adapter over the `t3` CLI (T3 Code, v0.1.9 on g7): JSON on stdout,
// exit 0. Errors are plain text on stderr with exit 1 — there is no
// JSON error envelope, so thread-gone is matched on the CLI's own
// sentences and everything else fails with the capped stderr excerpt.
// `--wait` runs exit 1 (run failed) and 2 (waits for an answer) per
// `t3 thread start --help`; goblin's delegation paths never wait (the
// watcher polls `show`), so only the completed exit-0 shape is pinned
// live. The runner is the fake edge for tests.

import { z } from "zod";
import { log } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";

export interface T3RunResult {
	code: number;
	stdout: string;
	stderr: string;
}
/** `signal` cancels the process; `timeoutMs` replaces the runner's
 *  default budget. Runners may ignore both. */
export interface T3CallOpts {
	signal?: AbortSignal;
	timeoutMs?: number;
}
export type T3Runner = (args: string[], opts?: T3CallOpts) => Promise<T3RunResult>;

// Read verbs are quick; a start only submits the message (no --wait),
// so one budget covers every verb goblin uses.
const T3_TIMEOUT_MS = 45_000;
const T3_MAX_OUTPUT = 1 << 20;
// Non-JSON CLI text is quoted as an excerpt this size — explains a
// usage error without flooding the log or the model's error prose.
const FALLBACK_EXCERPT = 200;

// The thread-gone sentences of v0.1.9, pinned in t3.live.test.ts. A
// drift here degrades to a generic error (the row stays watched), so
// the live check must stay green after t3 upgrades.
const THREAD_GONE_RE = /^Thread .+ (?:was not found|is no longer available)\.$/;

function cliFallbackMessage(r: T3RunResult): string {
	const text = (r.stderr || r.stdout).trim();
	if (text === "") return `exit ${r.code}`;
	const cut = text.slice(0, FALLBACK_EXCERPT);
	return cut.length < text.length ? `${cut}…` : cut;
}

const defaultRunner: T3Runner = async (args, opts) => {
	const budget = opts?.timeoutMs ?? T3_TIMEOUT_MS;
	const proc = spawnProc(["t3", ...args]);
	const r = await boundedRun(proc, {
		timeoutMs: budget,
		maxOutput: T3_MAX_OUTPUT,
		...(opts?.signal !== undefined ? { abortSignal: opts.signal } : {}),
	});
	return {
		code: r.exitCode ?? -1,
		stdout: r.stdout,
		// A killed run's real story is the kill, not partial stderr.
		stderr: r.timedOut
			? `t3 timed out after ${budget}ms`
			: r.truncated && r.stderr === ""
				? `t3 output exceeded the ${T3_MAX_OUTPUT}-byte cap and was killed`
				: r.stderr,
	};
};

// AbortSignal.reason is `any` — an Error reason is rethrown, else a
// plain abort Error.
function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

export class T3Error extends Error {
	readonly code: string;
	constructor(verb: string, code: string, message: string) {
		super(`t3 ${verb} failed (${code}): ${message}`);
		this.name = "T3Error";
		this.code = code;
	}
}

// ---------- wire shapes (zod-pinned against t3 v0.1.9) ----------

// Thread statuses observed live and documented on the MCP surface:
// preparing, queued, starting, running, waiting, idle, completed,
// interrupted, failed, cancelled, rolled_back. Kept as a string — an
// unknown status must not crash the adapter; the callers classify.
const threadStatus = z.string();

const pullRequestSchema = z.object({
	host: z.string(),
	repository: z.string(),
	number: z.number(),
	url: z.string(),
	source: z.string().optional(),
	state: z.string().optional(),
});

/** The thread record `show` returns in full and `list` returns per row
 *  (list omits the show-only fields; one schema covers both). */
const threadSchema = z.object({
	threadId: z.string(),
	projectId: z.string(),
	title: z.string(),
	link: z.string(),
	createdBy: z.string().optional(),
	creationSource: z.string().optional(),
	status: threadStatus,
	latestRunId: z.string().nullable().optional(),
	activeRunId: z.string().nullable().optional(),
	providerInstanceId: z.string().optional(),
	model: z.string().optional(),
	runtimeMode: z.string().optional(),
	interactionMode: z.string().optional(),
	linkedPullRequest: z.unknown().nullable().optional(),
	pullRequests: z.array(pullRequestSchema).optional(),
	titleRegeneration: z.unknown().nullable().optional(),
	branch: z.string().nullable().optional(),
	worktreePath: z.string().nullable().optional(),
	parentThreadId: z.string().nullable().optional(),
	relationshipToParent: z.string().nullable().optional(),
	runCount: z.number().optional(),
	itemCount: z.number().optional(),
	pendingRequestCount: z.number().optional(),
	archived: z.boolean().optional(),
	settled: z.boolean().optional(),
	settledAt: z.string().nullable().optional(),
	snoozed: z.boolean().optional(),
	snoozedUntil: z.string().nullable().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type T3Thread = z.infer<typeof threadSchema>;

const messageSchema = z.object({
	role: z.string(),
	runId: z.string().optional(),
	text: z.string(),
});
export type T3Message = z.infer<typeof messageSchema>;

const startResultSchema = z.object({
	threadId: z.string(),
	projectId: z.string(),
	runId: z.string(),
});
export interface T3StartResult extends z.infer<typeof startResultSchema> {}

const sendResultSchema = z.object({
	threadId: z.string(),
	link: z.string(),
	messageId: z.string(),
	runId: z.string(),
	status: z.string(),
	delivery: z.string(),
});
export interface T3SendResult extends z.infer<typeof sendResultSchema> {}

const showResultSchema = z.object({
	thread: threadSchema,
	messages: z.array(messageSchema),
});
export interface T3ShowResult extends z.infer<typeof showResultSchema> {}

function parseJson(verb: string, stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		// Parser diagnostics can quote CLI stdout — don't put raw agent
		// output into a log or error.
		throw new Error(`t3 ${verb}: stdout is not JSON`);
	}
}

// Log success only after the verb's result passes validation — runner
// rejection and invalid output each get their own boundary line;
// neither can masquerade as a good call. An aborting signal refuses
// the call before spawn and reports the abort after a killed run —
// never a fake CLI error for our own cancel.
function makeCaller(runner: T3Runner) {
	return async function call<T>(
		verb: string,
		target: string,
		args: string[],
		parse: (stdout: string) => T,
		opts?: T3CallOpts,
	): Promise<T> {
		const t0 = Date.now();
		if (opts?.signal?.aborted) throw abortError(opts.signal);
		let r: T3RunResult;
		try {
			r = await runner(args, opts);
		} catch (err) {
			log.error("t3 call runner failed", err, { verb, target, ms: Date.now() - t0 });
			throw err;
		}
		if (opts?.signal?.aborted) throw abortError(opts.signal);
		const ms = Date.now() - t0;
		if (r.code !== 0) {
			const text = r.stderr.trim();
			const code = THREAD_GONE_RE.test(text) ? "thread_not_found" : `exit_${r.code}`;
			log.info("t3 call", { verb, target, ms, outcome: `error:${code}` });
			throw new T3Error(verb, code, cliFallbackMessage(r));
		}
		let result: T;
		try {
			result = parse(r.stdout);
		} catch (err) {
			log.error("t3 call returned invalid output", err, { verb, target, ms });
			throw err;
		}
		log.info("t3 call", { verb, target, ms, outcome: "ok" });
		return result;
	};
}

export interface T3StartInput {
	/** Project id or a path inside the project (the delegation cwd). */
	project: string;
	message: string;
	provider: string;
	model: string;
	title?: string;
	worktree?: string;
	branch?: string;
}

export interface T3 {
	startThread(input: T3StartInput): Promise<T3StartResult>;
	/** A busy thread queues the message as its next turn; nothing is
	 *  interrupted. The returned runId attributions the watcher's
	 *  completion check. */
	sendThread(thread: string, message: string, opts?: T3CallOpts): Promise<T3SendResult>;
	/** null only when the CLI says the thread is gone; every other
	 *  failure throws with context (cannot observe, not gone). */
	showThread(
		thread: string,
		messages: number,
		opts?: T3CallOpts,
	): Promise<T3ShowResult | null>;
	listThreads(project: string, opts?: T3CallOpts): Promise<T3Thread[]>;
}

export function makeT3(run: T3Runner = defaultRunner): T3 {
	const call = makeCaller(run);
	return {
		async startThread(input) {
			const argv = [
				"thread",
				"start",
				input.project,
				input.message,
				"--provider",
				input.provider,
				"--model",
				input.model,
				"--json",
			];
			if (input.title !== undefined) argv.push("--title", input.title);
			if (input.worktree !== undefined) argv.push("--worktree", input.worktree);
			if (input.branch !== undefined) argv.push("--branch", input.branch);
			return call("thread start", input.project, argv, (stdout) =>
				startResultSchema.parse(parseJson("thread start", stdout)),
			);
		},

		async sendThread(thread, message, opts) {
			return call(
				"thread send",
				thread,
				["thread", "send", thread, message, "--json"],
				(stdout) => sendResultSchema.parse(parseJson("thread send", stdout)),
				opts,
			);
		},

		async showThread(thread, messages, opts) {
			try {
				return await call(
					"thread show",
					thread,
					[
						"thread",
						"show",
						thread,
						"--messages",
						String(messages),
						"--json",
					],
					(stdout) => showResultSchema.parse(parseJson("thread show", stdout)),
					opts,
				);
			} catch (err) {
				if (err instanceof T3Error && err.code === "thread_not_found") return null;
				throw err;
			}
		},

		async listThreads(project, opts) {
			return call(
				"thread list",
				project,
				["thread", "list", "--project", project, "--json"],
				(stdout) => z.array(threadSchema).parse(parseJson("thread list", stdout)),
				opts,
			);
		},
	};
}

// The statuses a thread cycles through while a run is in flight.
const WORKING_STATUSES: ReadonlySet<string> = new Set([
	"preparing",
	"queued",
	"starting",
	"running",
]);
/** True while a run is pending or executing — no verdict yet. */
export function t3Working(status: string): boolean {
	return WORKING_STATUSES.has(status);
}
/** True when the thread stopped for an answer the operator or goblin
 *  must supply (`--wait` exit 2 is the same condition). */
export function t3Waiting(status: string): boolean {
	return status === "waiting";
}
/** True when the thread ended without a result to evaluate — someone
 *  interrupted or cancelled it; treated as an outside stop. */
export function t3CutShort(status: string): boolean {
	return status === "interrupted" || status === "cancelled" || status === "rolled_back";
}
