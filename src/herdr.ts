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
/** Per-call overrides: `signal` cancels the process (the caller's
 *  boundary checks run before and after the run); `timeoutMs` replaces
 *  the runner's default budget for calls whose own deadline is longer
 *  (the operator prompt's `--wait`). Runners may ignore both. */
export interface HerdrCallOpts {
	signal?: AbortSignal;
	timeoutMs?: number;
}
export type HerdrRunner = (args: string[], opts?: HerdrCallOpts) => Promise<HerdrRunResult>;

// CLI calls are local-socket round trips — fast. The budget sits above
// `agent start`'s own 30 s startup wait so a timed-out start returns
// herdr's `timeout` code rather than our kill; the cap covers the
// largest payload in play (a couple hundred lines of screen text).
const HERDR_TIMEOUT_MS = 45_000;
// Forwarded machine calls ride ssh — give the round trip its own,
// larger budget before we call it dead.
const HERDR_REMOTE_TIMEOUT_MS = 90_000;
const HERDR_MAX_OUTPUT = 1 << 20;
// Raw CLI text that misses the JSON error envelope is quoted, never
// relayed — an excerpt this size explains a usage error to a human
// without flooding the log or the model's error prose (#98).
const FALLBACK_EXCERPT = 200;
// The read verbs put raw screen text on stdout — data, never an
// error message (design/delegation.md: failure screens travel
// fenced). A cap-killed read exits with empty stderr and up to 1 MiB
// of screen on stdout; the fallback must not quote it.
const READ_VERBS = new Set(["agent read", "pane read"]);

// The non-envelope fallback message: stderr when there is any, else
// stdout for the verbs whose stdout isn't screen text, capped to an
// excerpt.
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
			// A killed run's real story is the kill, not partial stderr:
			// the deadline names the timeout, the output cap names itself
			// (a real stderr envelope survives — only an empty one is
			// replaced, so the JSON error path keeps its code+message).
			stderr: r.timedOut
				? `herdr timed out after ${budget}ms`
				: r.truncated && r.stderr === ""
					? `herdr output exceeded the ${HERDR_MAX_OUTPUT}-byte cap and was killed`
					: r.stderr,
		};
	};
}

// An aborted signal throws the reason — an Error when there is one, a
// plain abort Error otherwise (script.ts's rule for AbortSignal.reason
// being `any`).
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

const workspaceIdentitySchema = z.object({
	result: z.object({ workspace: z.object({ workspace_id: z.string() }) }),
});
const workspaceCreatedSchema = z.object({
	result: z.object({
		// PaneInfo may omit cwd. Trust seeding needs the expanded path,
		// never the requested cwd, so its absence is a named refusal.
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
		// Parser diagnostics can quote a fragment of the CLI's stdout;
		// don't put raw agent output into a log or error.
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

// The operator-facing attach path for a delegation target — used by
// the delegate tool's results and the watcher's park notices (one
// source: both surfaces must agree). Local sessions attach by name
// (the own session is the unit's --session goblin). Machine targets
// have NO attachable command form: `--machine` is an API-command
// prefix (bare `herdr --machine <label>` is a usage error) and
// `session attach` is not machine-forwardable — the interactive TUI
// over ssh (`--remote <ssh-target>`) is the remote attach path, and
// the ssh target lives in herdr's machine registry, not our config.
export function attachHintFor(
	t: { machine?: string | undefined; session?: string | undefined } | null | undefined,
): string {
	if (t === null || t === undefined) return "herdr session attach goblin";
	if (t.machine !== undefined) return "herdr --remote <ssh-target> (see herdr machine list)";
	return `herdr session attach ${t.session ?? "goblin"}`;
}

// The one call path both adapters share — the delegation adapter's
// --session/--machine prefix and the operator adapter's hard-coded
// --session default. Log success only after this verb's result has
// passed validation: runner rejection and invalid output each get
// their own boundary line; neither can masquerade as a good call.
// An aborting signal refuses the call before spawn and reports the
// abort after a killed run — never a fake CLI error for our own cancel.
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

export function makeHerdr(
	target: HerdrTarget,
	run: HerdrRunner = defaultRunner,
	timeoutMs = "machine" in target ? HERDR_REMOTE_TIMEOUT_MS : HERDR_TIMEOUT_MS,
): Herdr {
	// `--machine` and `--session` are mutually exclusive per herdr's CLI
	// (the machine profile pins its own remote session); each call site
	// logs through `call` below regardless of the target kind.
	const prefix =
		"session" in target ? ["--session", target.session] : ["--machine", target.machine];
	// Forwarded calls are ssh round trips — machine adapters get the
	// longer budget (design/delegation.md, "Targets").
	const runner = run === defaultRunner ? makeRunner(timeoutMs) : run;
	const call = makeCaller(prefix, runner);

	return {
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
			await call("agent prompt", name, ["agent", "prompt", name, text], (stdout) =>
				envelopeSchema.parse(parseJson("agent prompt", stdout)),
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

		async paneRun(paneId, command) {
			await call("pane run", paneId, ["pane", "run", paneId, command], (stdout) => {
				// The real CLI's success is silent — no envelope. Empty stdout
				// is pane run's ok contract (pinned in herdr.live.test.ts); a
				// JSON envelope still parses if a future build emits one.
				if (stdout.trim() !== "") envelopeSchema.parse(parseJson("pane run", stdout));
			});
		},

		async paneWaitOutput(paneId, match, timeoutMs) {
			await call(
				"pane wait-output",
				paneId,
				["pane", "wait-output", paneId, "--match", match, "--timeout", String(timeoutMs)],
				(stdout) => envelopeSchema.parse(parseJson("pane wait-output", stdout)),
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
}

// ---------- the operator's session ----------

// The narrow adapter for the operator's own `default` session
// (design/delegation.md): read/list/prompt by pane ID only — no
// creation, raw keys, or session/machine arguments.

const OPERATOR_SESSION = "default";
// `agent prompt --wait` gets 120 s to observe a working/blocked state;
// the process budget sits just above so a genuine wait expiry comes
// back as herdr's own `timeout` code, not our kill.
const OPERATOR_PROMPT_WAIT_MS = 120_000;
const OPERATOR_PROMPT_BUDGET_MS = 125_000;

/** A refusal decided BEFORE any bytes reach the pane — the kind/pane
 *  check or a missing target. Distinct from HerdrError so callers can
 *  say "nothing was sent" truthfully; send-time HerdrError codes
 *  (`timeout`, `agent_prompt_stalled`) leave delivery uncertain. */
export class HerdrRefusal extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "HerdrRefusal";
		this.code = code;
	}
}

// The operator-session agent record — NOT the delegation schema:
// operator-launched agents are unnamed (`name` absent) and `agent`,
// `cwd`, `terminal_title` are optional on the wire.
const operatorAgentSchema = z.object({
	agent: z.string().optional(),
	agent_status: z.string(),
	name: z.string().optional(),
	pane_id: z.string(),
	workspace_id: z.string(),
	tab_id: z.string(),
	terminal_title: z.string().optional(),
	state_change_seq: z.number().int().optional(),
	cwd: z.string().optional(),
});
type OperatorAgentWire = z.infer<typeof operatorAgentSchema>;

const operatorAgentListSchema = z.object({
	result: z.object({ agents: z.array(operatorAgentSchema) }),
});
const operatorAgentResultSchema = z.object({
	result: z.object({ agent: operatorAgentSchema }),
});
const workspaceListSchema = z.object({
	result: z.object({
		workspaces: z.array(z.object({ workspace_id: z.string(), label: z.string() })),
	}),
});
const tabListSchema = z.object({
	result: z.object({
		tabs: z.array(z.object({ tab_id: z.string(), workspace_id: z.string(), label: z.string() })),
	}),
});

/** An operator-session agent joined with workspace/tab labels — null
 *  when a topology record vanished mid-read, never invented. */
export interface OperatorAgent {
	pane_id: string;
	workspace_id: string;
	tab_id: string;
	agent: string | null;
	agent_status: string;
	/** Present only when the agent is named — unnamed agents omit it. */
	name?: string;
	cwd: string | null;
	terminal_title: string | null;
	workspace_label: string | null;
	tab_label: string | null;
}

interface OperatorTopology {
	workspaces: Map<string, string>; // workspace_id → label
	tabs: Map<string, string>; // tab_id → label
}

export interface OperatorHerdr {
	/** Every agent in the session, label-joined; an empty set returns
	 *  [] without the topology round-trips. */
	list(signal?: AbortSignal): Promise<OperatorAgent[]>;
	/** The agent's screen tail — untrusted content; the caller fences. */
	read(pane: string, lines: number, signal?: AbortSignal): Promise<string>;
	/** Verify `pane` hosts kind `expect` (checked at `agent get` time —
	 *  the occupant can still change before the send lands), then submit
	 *  `text` through `agent prompt --wait --until working --until
	 *  blocked`. The wait proves a working/blocked state was observed —
	 *  not a new turn, and never task completion. HerdrRefusal =
	 *  nothing was sent; HerdrError from the send leaves delivery
	 *  uncertain. Returns the identity the response reported. */
	prompt(pane: string, expect: string, text: string, signal?: AbortSignal): Promise<OperatorAgent>;
}

export function makeOperatorHerdr(run: HerdrRunner = defaultRunner): OperatorHerdr {
	const call = makeCaller(["--session", OPERATOR_SESSION], run);

	async function topology(signal?: AbortSignal): Promise<OperatorTopology> {
		const ws = await call(
			"workspace list",
			"-",
			["workspace", "list"],
			(stdout) => workspaceListSchema.parse(parseJson("workspace list", stdout)),
			{ ...(signal !== undefined ? { signal } : {}) },
		);
		const workspaces = new Map<string, string>();
		// Per-workspace tab list: the unscoped form covers all
		// workspaces today, but the scoped form cannot regress.
		const tabs = new Map<string, string>();
		for (const w of ws.result.workspaces) {
			try {
				const listed = await call(
					"tab list",
					w.workspace_id,
					["tab", "list", "--workspace", w.workspace_id],
					(stdout) => tabListSchema.parse(parseJson("tab list", stdout)),
					{ ...(signal !== undefined ? { signal } : {}) },
				);
				workspaces.set(w.workspace_id, w.label);
				for (const tab of listed.result.tabs) tabs.set(tab.tab_id, tab.label);
			} catch (err) {
				// A workspace can close after list; omit its stale labels.
				// Every other failure was logged by call and must propagate.
				if (!(err instanceof HerdrError) || err.code !== "workspace_not_found") throw err;
				log.info("herdr topology workspace vanished", {
					workspace: w.workspace_id,
					session: OPERATOR_SESSION,
				});
			}
		}
		return { workspaces, tabs };
	}

	function viewAgent(agent: OperatorAgentWire, topo: OperatorTopology): OperatorAgent {
		return {
			pane_id: agent.pane_id,
			workspace_id: agent.workspace_id,
			tab_id: agent.tab_id,
			agent: agent.agent ?? null,
			agent_status: agent.agent_status,
			...(agent.name !== undefined ? { name: agent.name } : {}),
			cwd: agent.cwd ?? null,
			terminal_title: agent.terminal_title ?? null,
			workspace_label: topo.workspaces.get(agent.workspace_id) ?? null,
			tab_label: topo.tabs.get(agent.tab_id) ?? null,
		};
	}

	return {
		async list(signal) {
			const listed = await call(
				"agent list",
				"-",
				["agent", "list"],
				(stdout) => operatorAgentListSchema.parse(parseJson("agent list", stdout)),
				{ ...(signal !== undefined ? { signal } : {}) },
			);
			const agents = listed.result.agents;
			if (agents.length === 0) return [];
			const topo = await topology(signal);
			return agents.map((agent) => viewAgent(agent, topo));
		},

		async read(pane, lines, signal) {
			return call(
				"agent read",
				pane,
				["agent", "read", pane, "--source", "recent-unwrapped", "--lines", String(lines)],
				(stdout) => stdout,
				{ ...(signal !== undefined ? { signal } : {}) },
			);
		},

		async prompt(pane, expect, text, signal) {
			// Labels first; `agent get` is the LAST read before the send
			// and nothing is read after it — post-submit churn must not
			// turn a delivered prompt into an error.
			const topo = await topology(signal);
			let record: OperatorAgentWire;
			try {
				record = (
					await call(
						"agent get",
						pane,
						["agent", "get", pane],
						(stdout) => operatorAgentResultSchema.parse(parseJson("agent get", stdout)),
						{ ...(signal !== undefined ? { signal } : {}) },
					)
				).result.agent;
			} catch (err) {
				// `agent get` resolves pane targets only onto panes hosting
				// an agent — a bare pane is agent_not_found, same as gone.
				if (err instanceof HerdrError && err.code === "agent_not_found") {
					log.info("herdr prompt preflight", {
						pane,
						session: OPERATOR_SESSION,
						expect,
						outcome: "refuse:agent_not_found",
					});
					throw new HerdrRefusal("agent_not_found", `pane ${pane} does not host an agent`);
				}
				throw err;
			}
			// One preflight boundary line: what was verified at get time —
			// never the text.
			const preflight = {
				pane,
				session: OPERATOR_SESSION,
				expect,
				agent: record.agent ?? null,
				cwd: record.cwd ?? null,
				status: record.agent_status,
			};
			if (record.pane_id !== pane) {
				log.info("herdr prompt preflight", {
					...preflight,
					outcome: "refuse:pane_mismatch",
				});
				throw new HerdrRefusal(
					"pane_mismatch",
					`agent get ${pane} resolved to pane ${record.pane_id}`,
				);
			}
			if (record.agent !== expect) {
				log.info("herdr prompt preflight", {
					...preflight,
					outcome: "refuse:kind_mismatch",
				});
				throw new HerdrRefusal(
					"kind_mismatch",
					`pane ${pane} hosts ${record.agent ?? "no recognized agent kind"} — expected ${expect}`,
				);
			}
			log.info("herdr prompt preflight", { ...preflight, outcome: "allow" });
			// Flags precede `--` so a leading-dash prompt body stays a
			// literal positional, never a parsed flag.
			return viewAgent(
				await call(
					"agent prompt",
					pane,
					[
						"agent",
						"prompt",
						"--wait",
						"--until",
						"working",
						"--until",
						"blocked",
						"--timeout",
						String(OPERATOR_PROMPT_WAIT_MS),
						"--",
						pane,
						text,
					],
					(stdout) => {
						// A malformed or mismatched success response AFTER the
						// send means delivery is uncertain — a named code, never
						// "nothing was sent". Raw stdout is never quoted.
						let parsed: z.infer<typeof operatorAgentResultSchema>;
						try {
							parsed = operatorAgentResultSchema.parse(parseJson("agent prompt", stdout));
						} catch {
							throw new HerdrError(
								"agent prompt",
								"agent_prompt_invalid_response",
								"prompt response was not a recognized agent record",
							);
						}
						const a = parsed.result.agent;
						if (a.pane_id !== pane || a.agent !== expect)
							throw new HerdrError(
								"agent prompt",
								"agent_prompt_invalid_response",
								`prompt response did not match the submitted target (pane ${a.pane_id}, kind ${a.agent ?? "none"})`,
							);
						if (a.agent_status !== "working" && a.agent_status !== "blocked")
							throw new HerdrError(
								"agent prompt",
								"agent_prompt_invalid_response",
								`prompt response carries an unmatched status (${a.agent_status})`,
							);
						return a;
					},
					{
						...(signal !== undefined ? { signal } : {}),
						timeoutMs: OPERATOR_PROMPT_BUDGET_MS,
					},
				),
				topo,
			);
		},
	};
}
