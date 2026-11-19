import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
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
	) {
		super(`hc ${method}: ${message}`);
		this.name = "HcError";
	}
}

export interface Hc {
	run(input: {
		name: string;
		cwd: string;
		argv: string[];
		env: Record<string, string>;
	}): Promise<HcTerminal>;
	get(terminal: string): Promise<HcTerminal | null>;
	read(terminal: string, lines: number): Promise<string>;
	send(terminal: string, text: string, force?: boolean): Promise<void>;
	keys(terminal: string, keys: string[]): Promise<void>;
	kill(terminal: string): Promise<void>;
}

type SocketPath = { path: string };

function defaultSocketPath(session: string): SocketPath {
	const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
	const runtimeSocket = join(runtime, "herdr-core", `${session}.sock`);
	if (!existsSync(join(runtime, "herdr-core"))) {
		throw new HcError("connect", `runtime socket directory is missing: ${join(runtime, "herdr-core")}`);
	}
	return { path: runtimeSocket };
}

export function makeHc(
	session: string,
	socket: SocketPath = defaultSocketPath(session),
): Hc {
	let requestId = 0;

	async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = `goblin-${++requestId}`;
		const started = Date.now();
		try {
			const response = await new Promise<unknown>((resolve, reject) => {
				const connection = createConnection(socket.path);
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
							new HcError(method, `${kind === undefined ? "" : `${kind}: `}${envelope.data.error.message}`),
						);
						return;
					}
					finish(resolve, envelope.data.result);
				});
			});
			log.info("hc rpc", { method, ms: Date.now() - started, outcome: "ok" });
			return response;
		} catch (err) {
			log.error("hc rpc failed", err, { method, ms: Date.now() - started });
			throw err;
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
			return terminalSchema.parse(wire);
		},
		async get(terminal) {
			try {
				return terminalSchema.parse(await call("terminal.get", { terminal }));
			} catch (err) {
				if (err instanceof HcError && /not_found/.test(err.message)) return null;
				throw err;
			}
		},
		async read(terminal, lines) {
			return readSchema.parse(await call("terminal.read", { terminal, lines })).text;
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
