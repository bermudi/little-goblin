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
const HERDR_MAX_OUTPUT = 1 << 20;

const defaultRunner: HerdrRunner = async (args) => {
	const proc = spawnProc(["herdr", ...args]);
	const r = await boundedRun(proc, {
		timeoutMs: HERDR_TIMEOUT_MS,
		maxOutput: HERDR_MAX_OUTPUT,
	});
	return {
		code: r.exitCode ?? -1,
		stdout: r.stdout,
		// A killed run's real story is the timeout, not partial stderr.
		stderr: r.timedOut ? `herdr timed out after ${HERDR_TIMEOUT_MS}ms` : r.stderr,
	};
};

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
		root_pane: z.object({ pane_id: z.string() }),
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
	} catch (err) {
		throw new Error(
			`herdr ${verb}: stdout is not JSON — ${(err as Error).message}; got: ${stdout.slice(0, 200)}`,
		);
	}
}

export interface Herdr {
	createWorkspace(cwd: string, label: string): Promise<{ workspaceId: string; paneId: string }>;
	startAgent(name: string, kind: string, paneId: string, args: string[]): Promise<AgentInfo>;
	/** null only when herdr says the agent doesn't exist (agent_not_found);
	 *  every other failure throws with context. */
	get(name: string): Promise<AgentInfo | null>;
	prompt(name: string, text: string): Promise<void>;
	readAgent(name: string, lines: number): Promise<string>;
	readPane(paneId: string, lines: number): Promise<string>;
	interrupt(name: string): Promise<void>;
	closeWorkspace(id: string): Promise<void>;
}

export function makeHerdr(session: string, run: HerdrRunner = defaultRunner): Herdr {
	// The one call site: run argv under the session, lift the error
	// envelope on non-zero exit, log the boundary either way.
	async function call(verb: string, target: string, args: string[]): Promise<HerdrRunResult> {
		const t0 = Date.now();
		const r = await run(["--session", session, ...args]);
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
		log.info("herdr call", { verb, target, ms, outcome: "ok" });
		return r;
	}

	return {
		async createWorkspace(cwd, label) {
			const r = await call("workspace create", label, [
				"workspace", "create", "--cwd", cwd, "--label", label, "--no-focus",
			]);
			const parsed = workspaceCreatedSchema.parse(parseJson("workspace create", r.stdout));
			return {
				workspaceId: parsed.result.workspace.workspace_id,
				paneId: parsed.result.root_pane.pane_id,
			};
		},

		async startAgent(name, kind, paneId, args) {
			const argv = ["agent", "start", name, "--kind", kind, "--pane", paneId];
			if (args.length > 0) argv.push("--", ...args);
			const r = await call("agent start", name, argv);
			return agentResultSchema.parse(parseJson("agent start", r.stdout)).result.agent;
		},

		async get(name) {
			try {
				const r = await call("agent get", name, ["agent", "get", name]);
				return agentResultSchema.parse(parseJson("agent get", r.stdout)).result.agent;
			} catch (err) {
				if (err instanceof HerdrError && err.code === "agent_not_found") return null;
				throw err;
			}
		},

		async prompt(name, text) {
			const r = await call("agent prompt", name, ["agent", "prompt", name, text]);
			envelopeSchema.parse(parseJson("agent prompt", r.stdout));
		},

		async readAgent(name, lines) {
			const r = await call("agent read", name, [
				"agent", "read", name, "--source", "recent-unwrapped", "--lines", String(lines),
			]);
			return r.stdout;
		},

		async readPane(paneId, lines) {
			const r = await call("pane read", paneId, [
				"pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines),
			]);
			return r.stdout;
		},

		async interrupt(name) {
			const r = await call("agent send-keys", name, ["agent", "send-keys", name, "ctrl+c"]);
			envelopeSchema.parse(parseJson("agent send-keys", r.stdout));
		},

		async closeWorkspace(id) {
			const r = await call("workspace close", id, ["workspace", "close", id]);
			envelopeSchema.parse(parseJson("workspace close", r.stdout));
		},
	};
}
