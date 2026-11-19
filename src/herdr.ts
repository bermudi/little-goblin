// Adapter over the herdr CLI: JSON results on stdout,
// `{error:{code,message}}` on stderr with exit 1 (syntax errors exit
// 2). `agent read` / `pane read` are the exception — raw screen text,
// not the envelope. The runner is the fake edge for tests.

import { z } from "zod";
import { log } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";

/** `--session <name>` selects the local server. */
export type HerdrTarget = { session: string };

export interface HerdrRunResult {
	code: number;
	stdout: string;
	stderr: string;
}
/** `signal` cancels the process; `timeoutMs` replaces the runner's
 *  default budget for calls whose own deadline is longer (the operator
 *  prompt's `--wait`). Runners may ignore both. */
export interface HerdrCallOpts {
	signal?: AbortSignal;
	timeoutMs?: number;
}
export type HerdrRunner = (args: string[], opts?: HerdrCallOpts) => Promise<HerdrRunResult>;

// The budget sits above `agent start`'s own 30 s startup wait so a
// timed-out start returns herdr's `timeout` code rather than our kill.
const HERDR_TIMEOUT_MS = 45_000;
const HERDR_MAX_OUTPUT = 1 << 20;
// Non-envelope CLI text is quoted as an excerpt this size — explains a
// usage error without flooding the log or the model's error prose.
const FALLBACK_EXCERPT = 200;
// Read verbs put raw screen text on stdout — data, never an error
// message. A cap-killed read exits with empty stderr and up to 1 MiB
// of screen on stdout; the fallback must not quote it.
const READ_VERBS = new Set(["agent read", "pane read"]);

function cliFallbackMessage(verb: string, r: HerdrRunResult): string {
	const raw = READ_VERBS.has(verb) ? r.stderr : r.stderr || r.stdout;
	const text = raw.trim();
	if (text === "") return `exit ${r.code}`;
	const cut = text.slice(0, FALLBACK_EXCERPT);
	return cut.length < text.length ? `${cut}…` : cut;
}

const defaultRunner: HerdrRunner = makeRunner(HERDR_TIMEOUT_MS);

function makeRunner(timeoutMs: number): HerdrRunner {
	return async (args, opts) => {
		const budget = opts?.timeoutMs ?? timeoutMs;
		const proc = spawnProc(["herdr", ...args]);
		const r = await boundedRun(proc, {
			timeoutMs: budget,
			maxOutput: HERDR_MAX_OUTPUT,
			...(opts?.signal !== undefined ? { abortSignal: opts.signal } : {}),
		});
		return {
			code: r.exitCode ?? -1,
			stdout: r.stdout,
			// A killed run's real story is the kill, not partial stderr.
			// Only an EMPTY stderr is replaced — a real JSON envelope
			// keeps its code+message.
			stderr: r.timedOut
				? `herdr timed out after ${budget}ms`
				: r.truncated && r.stderr === ""
					? `herdr output exceeded the ${HERDR_MAX_OUTPUT}-byte cap and was killed`
					: r.stderr,
		};
	};
}

// AbortSignal.reason is `any` — an Error reason is rethrown, else a
// plain abort Error.
function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

export class HerdrError extends Error {
	readonly code: string;
	constructor(verb: string, code: string, message: string) {
		super(`herdr ${verb} failed (${code}): ${message}`);
		this.name = "HerdrError";
		this.code = code;
	}
}

// Extra fields herdr adds (focused, terminal ids, revision, …) are
// stripped.
//
// state_change_seq is required on both agent schemas: the fork has
// always reported it on every agent record, and a server that omits
// it is too old to observe safely — resets never bump the epoch and
// completions dedupe away (#327) — so its records fail loud here
// instead of losing events quietly.
const STATE_CHANGE_SEQ_MISSING =
	"state_change_seq is missing: the herdr server is too old (sequence numbers required)";
const stateChangeSeq = z
	.number({
		error: (issue) =>
			issue.input === undefined ? STATE_CHANGE_SEQ_MISSING : undefined,
	})
	.int();

const agentSchema = z.object({
	agent: z.string(), // the kind herdr launched (codex, pi, …)
	agent_status: z.string(), // idle | working | blocked | done | unknown
	name: z.string(),
	pane_id: z.string(),
	workspace_id: z.string(),
	state_change_seq: stateChangeSeq,
	/** Set on an idle transition that is completed work — startup and
	 *  session changes do not set it; matches that transition's
	 *  state_change_seq. Absent means no completed work yet: the current
	 *  server omits the field rather than reporting null. */
	completion_seq: z.number().int().optional(),
	cwd: z.string(),
	interactive_ready: z.boolean().optional(),
	launch_pending: z.boolean().optional(),
});
export type AgentInfo = z.infer<typeof agentSchema>;

const cliErrorSchema = z.object({
	error: z.object({ code: z.string(), message: z.string() }),
});

const workspaceIdentitySchema = z.object({
	result: z.object({ workspace: z.object({ workspace_id: z.string() }) }),
});
const workspaceCreatedSchema = z.object({
	result: z.object({
		// root_pane may omit cwd; trust seeding needs the expanded path,
		// never the requested cwd — its absence is a named refusal.
		root_pane: z.object({ pane_id: z.string(), cwd: z.string().optional() }),
	}),
});

/** A create succeeded, but its pane cannot be used. Preserve the id so
 *  the lifecycle can close the workspace even before bindLaunch. */
export class WorkspaceCreateError extends Error {
	constructor(
		readonly workspaceId: string,
		reason: string,
	) {
		super(`herdr workspace create: ${reason} (workspace ${workspaceId})`);
		this.name = "WorkspaceCreateError";
	}
}

const agentResultSchema = z.object({
	result: z.object({ agent: agentSchema }),
});

// Envelope presence only — ok-verbs (prompt, send-keys, close) carry a
// `{result:{type:"ok"}}` we don't model further.
const envelopeSchema = z.object({ result: z.unknown() });

function parseJson(verb: string, stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		// Parser diagnostics can quote CLI stdout — don't put raw agent
		// output into a log or error.
		throw new Error(`herdr ${verb}: stdout is not JSON`);
	}
}

export interface Herdr {
	createWorkspace(
		cwd: string,
		label: string,
	): Promise<{ workspaceId: string; paneId: string; cwd: string }>;
	startAgent(name: string, kind: string, paneId: string, args: string[]): Promise<AgentInfo>;
	/** null only when herdr says the agent doesn't exist (agent_not_found);
	 *  every other failure throws with context. */
	get(name: string): Promise<AgentInfo | null>;
	prompt(name: string, text: string): Promise<void>;
	/** A single keypress into the agent's pane — the only input a
	 *  `blocked` agent accepts (dialog answers); `prompt` is rejected
	 *  while blocked. Key names are herdr's: enter, esc, arrows, or a
	 *  literal character. */
	sendKey(name: string, key: string): Promise<void>;
	readAgent(name: string, lines: number): Promise<string>;
	readPane(paneId: string, lines: number): Promise<string>;
	interrupt(name: string): Promise<void>;
	closeWorkspace(id: string): Promise<void>;
}

// One attach-path source for the delegate tool's results and the
// watcher's park notices — both surfaces must agree.
export function attachHintFor(
	t: { session?: string | undefined } | null | undefined,
): string {
	return `herdr session attach ${t?.session ?? "goblin"}`;
}

// Log success only after the verb's result passes validation — runner
// rejection and invalid output each get their own boundary line;
// neither can masquerade as a good call. An aborting signal refuses
// the call before spawn and reports the abort after a killed run —
// never a fake CLI error for our own cancel.
function makeCaller(prefix: string[], runner: HerdrRunner) {
	return async function call<T>(
		verb: string,
		target: string,
		args: string[],
		parse: (stdout: string) => T,
		opts?: HerdrCallOpts,
	): Promise<T> {
		const t0 = Date.now();
		if (opts?.signal?.aborted) throw abortError(opts.signal);
		let r: HerdrRunResult;
		try {
			r = await runner([...prefix, ...args], opts);
		} catch (err) {
			log.error("herdr call runner failed", err, { verb, target, ms: Date.now() - t0 });
			throw err;
		}
		if (opts?.signal?.aborted) throw abortError(opts.signal);
		const ms = Date.now() - t0;
		if (r.code !== 0) {
			let code = `exit_${r.code}`;
			let message = cliFallbackMessage(verb, r);
			try {
				const parsed = cliErrorSchema.parse(JSON.parse(r.stderr));
				code = parsed.error.code;
				message = parsed.error.message;
			} catch {
				// stderr wasn't the JSON envelope — keep the capped raw text.
			}
			log.info("herdr call", { verb, target, ms, outcome: `error:${code}` });
			throw new HerdrError(verb, code, message);
		}
		let result: T;
		try {
			result = parse(r.stdout);
		} catch (err) {
			log.error("herdr call returned invalid output", err, { verb, target, ms });
			throw err;
		}
		log.info("herdr call", { verb, target, ms, outcome: "ok" });
		return result;
	};
}

// `agent prompt` returns ok once the text is typed, not once the TUI
// accepted the Enter: a harness whose ready gate fires before its editor
// is live (pi under parallel startup, 2026-11-06) keeps the task as an
// unsent draft. Delivery is proven by the agent leaving idle or its
// state_change_seq moving; one recovery Enter, then fail loud.
const DELIVERY_POLL_MS = 400;
const DELIVERY_WINDOW_MS = 3_000;

export function makeHerdr(
	target: HerdrTarget,
	run: HerdrRunner = defaultRunner,
	timeoutMs = HERDR_TIMEOUT_MS,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Herdr {
	const prefix = ["--session", target.session];
	const runner = run === defaultRunner ? makeRunner(timeoutMs) : run;
	const call = makeCaller(prefix, runner);

	const self: Herdr = {
		async createWorkspace(cwd, label) {
			const parsed = await call(
				"workspace create",
				label,
				["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"],
				(stdout) => {
					const wire = parseJson("workspace create", stdout);
					const workspaceId = workspaceIdentitySchema.parse(wire).result.workspace.workspace_id;
					const pane = workspaceCreatedSchema.safeParse(wire);
					if (!pane.success) {
						throw new WorkspaceCreateError(workspaceId, "invalid root pane response");
					}
					const { pane_id: paneId, cwd } = pane.data.result.root_pane;
					if (cwd === undefined) {
						throw new WorkspaceCreateError(
							workspaceId,
							"root pane cwd unavailable; cannot seed trust safely",
						);
					}
					return { workspaceId, paneId, cwd };
				},
			);
			return parsed;
		},

		async startAgent(name, kind, paneId, args) {
			const argv = ["agent", "start", name, "--kind", kind, "--pane", paneId];
			if (args.length > 0) argv.push("--", ...args);
			return (
				await call("agent start", name, argv, (stdout) =>
					agentResultSchema.parse(parseJson("agent start", stdout)),
				)
			).result.agent;
		},

		async get(name) {
			try {
				return (
					await call("agent get", name, ["agent", "get", name], (stdout) =>
						agentResultSchema.parse(parseJson("agent get", stdout)),
					)
				).result.agent;
			} catch (err) {
				if (err instanceof HerdrError && err.code === "agent_not_found") return null;
				throw err;
			}
		},

		async prompt(name, text) {
			// Only an idle agent can be sitting on a draft; a working one
			// queues the input itself.
			const before = await self.get(name);
			// `--` keeps a leading-dash task text a literal positional.
			await call("agent prompt", name, ["agent", "prompt", "--", name, text], (stdout) =>
				envelopeSchema.parse(parseJson("agent prompt", stdout)),
			);
			if (before === null || before.agent_status !== "idle") return;
			const delivered = async (): Promise<boolean> => {
				for (let waited = 0; waited < DELIVERY_WINDOW_MS; waited += DELIVERY_POLL_MS) {
					await sleep(DELIVERY_POLL_MS);
					const now = await self.get(name);
					if (now === null) return false;
					if (now.agent_status !== "idle" || now.state_change_seq !== before.state_change_seq) {
						return true;
					}
				}
				return false;
			};
			if (await delivered()) return;
			log.warn("herdr prompt left unsent — sending recovery enter", { agent: name });
			await self.sendKey(name, "enter");
			if (await delivered()) return;
			throw new HerdrError(
				"agent prompt",
				"agent_prompt_unsubmitted",
				"prompt was typed but the agent never left idle, even after a recovery Enter",
			);
		},

		async readAgent(name, lines) {
			return call(
				"agent read",
				name,
				["agent", "read", name, "--source", "recent-unwrapped", "--lines", String(lines)],
				(stdout) => stdout,
			);
		},

		async readPane(paneId, lines) {
			return call(
				"pane read",
				paneId,
				["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)],
				(stdout) => stdout,
			);
		},


		async sendKey(name, key) {
			await call("agent send-keys", name, ["agent", "send-keys", name, key], (stdout) =>
				envelopeSchema.parse(parseJson("agent send-keys", stdout)),
			);
		},

		async interrupt(name) {
			await call("agent send-keys", name, ["agent", "send-keys", name, "ctrl+c"], (stdout) =>
				envelopeSchema.parse(parseJson("agent send-keys", stdout)),
			);
		},

		async closeWorkspace(id) {
			await call("workspace close", id, ["workspace", "close", id], (stdout) =>
				envelopeSchema.parse(parseJson("workspace close", stdout)),
			);
		},
	};
	return self;
}
