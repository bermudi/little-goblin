import { createConnection } from "node:net";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ensureHc } from "./hc-install.ts";
import { log } from "./log.ts";

const statusSchema = z.object({
	state: z.enum(["idle", "working", "blocked", "done", "error"]),
	kind: z.string().optional(),
	app: z.string().optional(),
	title: z.string().optional(),
	msg: z.string().optional(),
});

const terminalSchema = z.object({
	address: z.string(),
	argv: z.array(z.string()),
	cwd: z.string(),
	exit_code: z.number().int().nullable(),
	name: z.string().nullable(),
	pid: z.number().int().nullable(),
	state: z.enum(["live", "finished"]),
	status: statusSchema.nullable(),
	status_ms: z.number().int().nonnegative().nullable().optional(),
	turn: z.number().int().nonnegative(),
});

export type HcTerminal = z.infer<typeof terminalSchema>;

const readSchema = z.object({
	text: z.string(),
	complete: z.boolean(),
	how: z.string(),
	why: z.string().optional(),
});
const listSchema = z.object({ terminals: z.array(terminalSchema) }).passthrough();

const envelopeSchema = z.object({
	id: z.string(),
	result: z.unknown().optional(),
	error: z.object({
		code: z.number(),
		message: z.string(),
		data: z.object({ kind: z.string().optional() }).passthrough().optional(),
	}).optional(),
});

export class HcError extends Error {
	constructor(
		readonly method: string,
		message: string,
		readonly code = "hc_error",
	) {
		super(`hc ${method}: ${message}`);
		this.name = "HcError";
	}
}

function parseReply<T>(schema: z.ZodType<T>, method: string, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new HcError(method, "response did not match the pinned schema", "invalid_reply");
	return parsed.data;
}

export interface Hc {
	run(input: {
		name: string;
		cwd: string;
		argv: string[];
		env: Record<string, string>;
	}): Promise<HcTerminal>;
	get(terminal: string): Promise<HcTerminal | null>;
	list(): Promise<HcTerminal[]>;
	read(terminal: string, lines: number): Promise<string>;
	send(terminal: string, text: string, force?: boolean): Promise<void>;
	keys(terminal: string, keys: string[]): Promise<void>;
	kill(terminal: string): Promise<void>;
}

export function hcSessionForHome(home: string): string {
	return `goblin-${createHash("sha256").update(realpathSync(home)).digest("hex").slice(0, 8)}`;
}

const hcCoreEnvironmentNames = [
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PATH",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"XDG_RUNTIME_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"TMPDIR",
] as const;

function hcCoreEnvironment(): string[] {
	const values = hcCoreEnvironmentNames.flatMap((name) => {
		const value = process.env[name];
		return value === undefined ? [] : [`${name}=${value}`];
	});
	if (process.env.TERM === undefined) values.push("TERM=xterm-256color");
	return values;
}

export async function ensureHcCore(binaryPath: string, session: string): Promise<void> {
	await ensureHc(binaryPath);
	const started = Date.now();
	const result = Bun.spawnSync(
		[
			"systemd-run",
			"--user",
			"--scope",
			"-q",
			"env",
			"-i",
			...hcCoreEnvironment(),
			`HC_SESSION=${session}`,
			binaryPath,
			"server",
			"start",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString("utf8").trim().slice(0, 300);
		const error = new Error(`systemd-run could not start hc (${result.exitCode}): ${stderr}`);
		log.error("hc core start failed", error, { session, ms: Date.now() - started });
		throw error;
	}
	log.info("hc core start requested", { session, ms: Date.now() - started });
}

export function stopHcCore(binaryPath: string, session: string): void {
	const result = Bun.spawnSync(
		["env", `HC_SESSION=${session}`, binaryPath, "server", "stop"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString("utf8").trim().slice(0, 300);
		const error = new Error(`hc server stop failed (${result.exitCode}): ${stderr}`);
		log.error("hc core stop failed", error, { session });
		throw error;
	}
	log.info("hc core stopped", { session });
}

type SocketPath = { path: string };

function defaultSocketPath(session: string): SocketPath {
	const runtime = process.env.XDG_RUNTIME_DIR;
	if (!runtime) {
		throw new HcError("connect", "XDG_RUNTIME_DIR is not set", "runtime_dir_missing");
	}
	const runtimeSocket = join(runtime, "herdr-core", `${session}.sock`);
	if (!existsSync(join(runtime, "herdr-core"))) {
		throw new HcError("connect", `runtime socket directory is missing: ${join(runtime, "herdr-core")}`);
	}
	return { path: runtimeSocket };
}

export function makeHc(
	session: string,
	socket?: SocketPath,
): Hc {
	let requestId = 0;

	async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = `goblin-${++requestId}`;
		const started = Date.now();
		try {
			const socketPath = socket?.path ?? defaultSocketPath(session).path;
			const response = await new Promise<unknown>((resolve, reject) => {
				const connection = createConnection(socketPath);
				let data = "";
				let settled = false;
				const finish = (fn: (value: never) => void, value: unknown): void => {
					if (settled) return;
					settled = true;
					connection.destroy();
					fn(value as never);
				};
				connection.setTimeout(15_000, () => {
					finish(reject, new HcError(method, "socket request timed out"));
				});
				connection.on("error", (err) => finish(reject, err));
				connection.on("connect", () => {
					connection.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
				});
				connection.on("data", (chunk: Buffer) => {
					data += chunk.toString("utf8");
					const newline = data.indexOf("\n");
					if (newline < 0) return;
					let decoded: unknown;
					try {
						decoded = JSON.parse(data.slice(0, newline));
					} catch {
						finish(reject, new HcError(method, "response was not JSON"));
						return;
					}
					const envelope = envelopeSchema.safeParse(decoded);
					if (!envelope.success || envelope.data.id !== id) {
						finish(reject, new HcError(method, "invalid JSON-RPC response envelope"));
						return;
					}
					if (envelope.data.error !== undefined) {
						const kind = envelope.data.error.data?.kind;
						finish(
							reject,
							new HcError(method, envelope.data.error.message, kind ?? "hc_error"),
						);
						return;
					}
					finish(resolve, envelope.data.result);
				});
			});
			log.info("hc rpc", { method, ms: Date.now() - started, outcome: "ok" });
			return response;
		} catch (err) {
			const error = err instanceof HcError
				? err
				: new HcError(method, err instanceof Error ? err.message : String(err), "transport_error");
			log.error("hc rpc failed", error, { method, ms: Date.now() - started });
			throw error;
		}
	}

	return {
		async run(input) {
			const wire = await call("terminal.run", {
				name: input.name,
				cwd: input.cwd,
				argv: input.argv,
				env: input.env,
				outlive_parent: true,
			});
			return parseReply(terminalSchema, "terminal.run", wire);
		},
		async get(terminal) {
			try {
				return parseReply(terminalSchema, "terminal.get", await call("terminal.get", { terminal }));
			} catch (err) {
				if (err instanceof HcError && err.code === "not_found") return null;
				throw err;
			}
		},
		async list() {
			return parseReply(listSchema, "terminal.list", await call("terminal.list", { all: true })).terminals;
		},
		async read(terminal, lines) {
			return parseReply(readSchema, "terminal.read", await call("terminal.read", { terminal, lines })).text;
		},
		async send(terminal, text, force = false) {
			await call("terminal.send", { terminal, text, force });
		},
		async keys(terminal, keys) {
			await call("terminal.keys", { terminal, keys });
		},
		async kill(terminal) {
			await call("terminal.kill", { terminal });
		},
	};
}
