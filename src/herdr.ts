// The only module that knows herdr (DESIGN.md, "Delegation") — a thin
// adapter over the CLI: `herdr --session <name> …`, JSON results on
// stdout, `{error:{code,message}}` JSON on stderr with exit 1 (syntax
// errors exit 2). Reads are the exception: `agent read` / `pane read`
// emit raw screen text, not the envelope. Every response is zod-parsed
// at this boundary and every call logs verb, target, outcome, ms — the
// log has to reconstruct what the multiplexer was told without a REPL.
// The runner is the fake edge for tests.

import { z } from "zod";
import { log } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";

/** Where harnesses run: the local `--session <name>` server, or a
 *  saved-machine profile (`--machine <label>`) whose pinned remote
 *  session lives on another host (design/delegation.md). */
export type HerdrTarget = { session: string } | { machine: string };

export interface HerdrRunResult {
	code: number;
	stdout: string;
	stderr: string;
}
export type HerdrRunner = (args: string[]) => Promise<HerdrRunResult>;

// CLI calls are local-socket round trips — fast. The budget sits above
// `agent start`'s own 30 s startup wait so a timed-out start returns
// herdr's `timeout` code rather than our kill; the cap covers the
// largest payload in play (a couple hundred lines of screen text).
const HERDR_TIMEOUT_MS = 45_000;
// Forwarded machine calls ride ssh — give the round trip its own,
// larger budget before we call it dead.
const HERDR_REMOTE_TIMEOUT_MS = 90_000;
const HERDR_MAX_OUTPUT = 1 << 20;

const defaultRunner: HerdrRunner = makeRunner(HERDR_TIMEOUT_MS);

function makeRunner(timeoutMs: number): HerdrRunner {
	return async (args) => {
		const proc = spawnProc(["herdr", ...args]);
		const r = await boundedRun(proc, {
			timeoutMs,
			maxOutput: HERDR_MAX_OUTPUT,
		});
		return {
			code: r.exitCode ?? -1,
			stdout: r.stdout,
			// A killed run's real story is the timeout, not partial stderr.
			stderr: r.timedOut ? `herdr timed out after ${timeoutMs}ms` : r.stderr,
		};
	};
}

export class HerdrError extends Error {
	readonly code: string;
	constructor(verb: string, code: string, message: string) {
		super(`herdr ${verb} failed (${code}): ${message}`);
		this.name = "HerdrError";
		this.code = code;
	}
}

// The agent record herdr reports (`agent get`, `agent start`,
// `agent list`). Extra fields herdr adds (focused, terminal ids,
// revision, …) are stripped — we model what delegation consumes.
const agentSchema = z.object({
	agent: z.string(), // the kind herdr launched (codex, pi, …)
	agent_status: z.string(), // idle | working | blocked | done | unknown
	name: z.string(),
	pane_id: z.string(),
	workspace_id: z.string(),
	state_change_seq: z.number().int(),
	/** Set on an idle transition that is completed work — startup and
	 *  session changes do not set it; matches that transition's
	 *  state_change_seq. Optional: older servers omit it and done
	 *  detection falls back to the seq-advance rule. */
	completion_seq: z.number().int().optional(),
	cwd: z.string(),
	interactive_ready: z.boolean().optional(),
	launch_pending: z.boolean().optional(),
});
export type AgentInfo = z.infer<typeof agentSchema>;

const cliErrorSchema = z.object({
	error: z.object({ code: z.string(), message: z.string() }),
});

const workspaceCreatedSchema = z.object({
	result: z.object({
		workspace: z.object({ workspace_id: z.string() }),
		// The pane's real cwd: the CLI expanded any `~` (locally or, for
		// machine-forwarded creates, on the target) — trust markers must
		// key THIS path, not the `~`-form we sent.
		root_pane: z.object({ pane_id: z.string(), cwd: z.string() }),
	}),
});

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
		// Parser diagnostics can quote a fragment of the CLI's stdout;
		// don't put raw agent output into a log or error.
		throw new Error(`herdr ${verb}: stdout is not JSON`);
	}
}

export interface Herdr {
	createWorkspace(cwd: string, label: string): Promise<{ workspaceId: string; paneId: string; cwd: string }>;
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
	/** Submit a shell command in a pane (text + Enter, one ordered
	 *  submission). Used to seed remote trust stores in the
	 *  delegation's own root pane before `agent start`. */
	paneRun(paneId: string, command: string): Promise<void>;
	/** Poll a pane's recent snapshot until a literal substring shows
	 *  (Rust-regex via --regex, but the seed only needs --match). */
	paneWaitOutput(paneId: string, match: string, timeoutMs: number): Promise<void>;
	interrupt(name: string): Promise<void>;
	closeWorkspace(id: string): Promise<void>;
}

export function makeHerdr(
	target: HerdrTarget,
	run: HerdrRunner = defaultRunner,
	timeoutMs = "machine" in target ? HERDR_REMOTE_TIMEOUT_MS : HERDR_TIMEOUT_MS,
): Herdr {
	// `--machine` and `--session` are mutually exclusive per herdr's CLI
	// (the machine profile pins its own remote session); each call site
	// logs through `call` below regardless of the target kind.
	const prefix = "session" in target ? ["--session", target.session] : ["--machine", target.machine];
	// Forwarded calls are ssh round trips — machine adapters get the
	// longer budget (design/delegation.md, "Targets").
	const runner = run === defaultRunner ? makeRunner(timeoutMs) : run;
	// The one call site: log success only after this verb's result has
	// passed validation. Runner rejection and invalid output each get
	// their own boundary line; neither can masquerade as a good call.
	async function call<T>(
		verb: string,
		target: string,
		args: string[],
		parse: (stdout: string) => T,
	): Promise<T> {
		const t0 = Date.now();
		let r: HerdrRunResult;
		try {
			r = await runner([...prefix, ...args]);
		} catch (err) {
			log.error("herdr call runner failed", err, { verb, target, ms: Date.now() - t0 });
			throw err;
		}
		const ms = Date.now() - t0;
		if (r.code !== 0) {
			let code = `exit_${r.code}`;
			let message = (r.stderr || r.stdout).trim() || `exit ${r.code}`;
			try {
				const parsed = cliErrorSchema.parse(JSON.parse(r.stderr));
				code = parsed.error.code;
				message = parsed.error.message;
			} catch {
				// stderr wasn't the JSON envelope — keep the raw text.
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
	}

	return {
		async createWorkspace(cwd, label) {
			const parsed = await call("workspace create", label, [
				"workspace", "create", "--cwd", cwd, "--label", label, "--no-focus",
			], (stdout) => workspaceCreatedSchema.parse(parseJson("workspace create", stdout)));
			return {
				workspaceId: parsed.result.workspace.workspace_id,
				paneId: parsed.result.root_pane.pane_id,
				cwd: parsed.result.root_pane.cwd,
			};
		},

		async startAgent(name, kind, paneId, args) {
			const argv = ["agent", "start", name, "--kind", kind, "--pane", paneId];
			if (args.length > 0) argv.push("--", ...args);
			return (await call("agent start", name, argv,
				(stdout) => agentResultSchema.parse(parseJson("agent start", stdout)))).result.agent;
		},

		async get(name) {
			try {
				return (await call("agent get", name, ["agent", "get", name],
					(stdout) => agentResultSchema.parse(parseJson("agent get", stdout)))).result.agent;
			} catch (err) {
				if (err instanceof HerdrError && err.code === "agent_not_found") return null;
				throw err;
			}
		},

		async prompt(name, text) {
			await call("agent prompt", name, ["agent", "prompt", name, text],
				(stdout) => envelopeSchema.parse(parseJson("agent prompt", stdout)));
		},

		async readAgent(name, lines) {
			return call("agent read", name, [
				"agent", "read", name, "--source", "recent-unwrapped", "--lines", String(lines),
			], (stdout) => stdout);
		},

		async readPane(paneId, lines) {
			return call("pane read", paneId, [
				"pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines),
			], (stdout) => stdout);
		},

		async paneRun(paneId, command) {
			await call("pane run", paneId, ["pane", "run", paneId, command],
				(stdout) => envelopeSchema.parse(parseJson("pane run", stdout)));
		},

		async paneWaitOutput(paneId, match, timeoutMs) {
			await call("pane wait-output", paneId, [
				"pane", "wait-output", paneId, "--match", match, "--timeout", String(timeoutMs),
			], (stdout) => envelopeSchema.parse(parseJson("pane wait-output", stdout)));
		},

		async sendKey(name, key) {
			await call("agent send-keys", name, ["agent", "send-keys", name, key],
				(stdout) => envelopeSchema.parse(parseJson("agent send-keys", stdout)));
		},

		async interrupt(name) {
			await call("agent send-keys", name, ["agent", "send-keys", name, "ctrl+c"],
				(stdout) => envelopeSchema.parse(parseJson("agent send-keys", stdout)));
		},

		async closeWorkspace(id) {
			await call("workspace close", id, ["workspace", "close", id],
				(stdout) => envelopeSchema.parse(parseJson("workspace close", stdout)));
		},
	};
}
