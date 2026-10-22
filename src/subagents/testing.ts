import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Harness } from "@earendil-works/pi-durable";
import type { SubagentsConfig } from "../config.ts";
import type { DesktopAction, DesktopRow, Desktops, LeaseHolder } from "../desktops.ts";
import { DesktopError, DesktopLeaseError } from "../desktops.ts";
import { setLogFile, setLogWriter } from "../log.ts";
import { SandboxError, type Sandboxes } from "../sandboxes.ts";
import { openSubagentRuns, type SubagentRuns } from "../subagent-runs.ts";
import { openSubagents, type Subagents } from "./mod.ts";
import { type SubagentModelProfile, subagentModelProfileSchema } from "./models.ts";

export function captureLog(): { lines: string[]; stop: () => void } {
	const lines: string[] = [];
	setLogFile("subagent-test.log");
	setLogWriter((_path, line) => lines.push(line));
	return {
		lines,
		stop() {
			setLogFile(null);
			setLogWriter(null);
		},
	};
}

export function harnessReports(lines: string[]): string[] {
	return lines.filter((line) => line.includes("subagent harness report"));
}

type FakeUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export type FakeReply =
	| { kind: "text"; text: string; usage?: FakeUsage; finish?: string }
	| { kind: "tools"; calls: { name: string; args: Record<string, unknown> }[]; usage?: FakeUsage }
	| { kind: "hold"; gate: Promise<void> | (() => Promise<void>); then?: FakeReply }
	| { kind: "fail"; status: number; body: string }
	| { kind: "abort" };

interface SeenRequest {
	tools: string[];
	messages: unknown;
	raw: Record<string, unknown>;
}

export interface FakeModel {
	port: number;
	url: string;
	seen: SeenRequest[];
	push(reply: FakeReply): void;
	close(): void;
	onRequest?: (body: unknown) => FakeReply | null;
}

function sse(events: object[]): Response {
	const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
	return new Response(lines, {
		headers: { "content-type": "text/event-stream" },
	});
}

function chunkFor(reply: FakeReply, i: number): object[] {
	if (reply.kind === "tools") {
		return [
			{
				id: `c${i}`,
				object: "chat.completion.chunk",
				created: 1,
				model: "fake",
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: reply.calls.map((c, j) => ({
								index: j,
								id: `call_${i}_${j}`,
								type: "function",
								function: { name: c.name, arguments: JSON.stringify(c.args) },
							})),
						},
						finish_reason: null,
					},
				],
			},
			{
				id: `c${i}`,
				object: "chat.completion.chunk",
				created: 1,
				model: "fake",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				usage: reply.usage ?? {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
				},
			},
		];
	}
	return [
		{
			id: `c${i}`,
			object: "chat.completion.chunk",
			created: 1,
			model: "fake",
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: reply.kind === "text" ? reply.text : "" },
					finish_reason: null,
				},
			],
		},
		{
			id: `c${i}`,
			object: "chat.completion.chunk",
			created: 1,
			model: "fake",
			choices: [
				{
					index: 0,
					delta: {},
					finish_reason:
						reply.kind === "text" && reply.finish !== undefined ? reply.finish : "stop",
				},
			],
			usage:
				reply.kind === "text" && reply.usage !== undefined
					? reply.usage
					: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		},
	];
}

export function startFakeModel(): FakeModel {
	const defaultQueue: FakeReply[] = [];
	const seen: SeenRequest[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const body = (await req.json()) as {
				messages?: { role: string; content: unknown }[];
				tools?: { function?: { name?: string } }[];
			};
			seen.push({
				tools: (body.tools ?? []).map((t) => t.function?.name ?? "?"),
				messages: body.messages,
				raw: body as Record<string, unknown>,
			});
			const reply: FakeReply =
				model.onRequest?.(body) ??
				(defaultQueue.length > 0
					? defaultQueue.shift()!
					: { kind: "text", text: "unscripted reply" });
			if (reply.kind === "fail") {
				return new Response(reply.body, { status: reply.status });
			}
			if (reply.kind === "abort") {
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({
									id: "c1",
									object: "chat.completion.chunk",
									created: 1,
									model: "fake",
									choices: [
										{
											index: 0,
											delta: { content: "partial" },
											finish_reason: null,
										},
									],
								})}\n\n`,
							),
						);
						controller.error(new Error("socket dropped mid-stream"));
					},
				});
				return new Response(stream, {
					headers: { "content-type": "text/event-stream" },
				});
			}
			if (reply.kind === "hold") {
				const gate = reply.gate;
				await (typeof gate === "function" ? gate() : gate);
				return sse(chunkFor(reply.then ?? { kind: "text", text: "released" }, seen.length));
			}
			return sse(chunkFor(reply, seen.length));
		},
	});
	const port = server.port ?? 0;
	const model: FakeModel = {
		port,
		url: `http://127.0.0.1:${port}`,
		seen,
		push(reply) {
			defaultQueue.push(reply);
		},
		close() {
			void server.stop(true);
		},
	};
	return model;
}

type ExecResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
	killed: boolean;
	stdoutBytes?: Uint8Array;
};

type MemNode = { data: Uint8Array; mtime: number } | { dir: true };

class MemFS {
	private nodes = new Map<string, MemNode>();
	constructor() {
		for (const d of ["/", "/work", "/tmp", "/inbox", "/home", "/home/desk"]) {
			this.nodes.set(d, { dir: true });
		}
	}
	norm(p: string, cwd = "/work"): string {
		return posix.normalize(p.startsWith("/") ? p : `${cwd}/${p}`);
	}
	isDir(p: string): boolean {
		const n = this.nodes.get(p);
		return n !== undefined && "dir" in n;
	}
	isFile(p: string): boolean {
		const n = this.nodes.get(p);
		return n !== undefined && "data" in n;
	}
	exists(p: string): boolean {
		return this.nodes.has(p);
	}
	read(p: string): Uint8Array {
		const n = this.nodes.get(p);
		if (n === undefined) throw new Error(`ENOENT: ${p}`);
		if ("dir" in n) throw new Error(`EISDIR: ${p}`);
		return n.data;
	}
	write(p: string, data: Uint8Array, append = false): void {
		const parent = posix.dirname(p);
		if (!this.isDir(parent)) throw new Error(`ENOENT: ${p}`);
		const cur = this.nodes.get(p);
		if (cur !== undefined && "dir" in cur) throw new Error(`EISDIR: ${p}`);
		const next =
			append && cur !== undefined && "data" in cur ? new Uint8Array([...cur.data, ...data]) : data;
		this.nodes.set(p, { data: next, mtime: Date.now() });
	}
	mkdir(p: string, recursive: boolean): void {
		if (this.exists(p)) {
			if (this.isDir(p)) return;
			throw new Error(`EEXIST: ${p}`);
		}
		const parent = posix.dirname(p);
		if (!this.isDir(parent)) {
			if (!recursive) throw new Error(`ENOENT: ${p}`);
			this.mkdir(parent, true);
		}
		this.nodes.set(p, { dir: true });
	}
	rm(p: string, opts: { recursive?: boolean; force?: boolean }): void {
		if (!this.exists(p)) {
			if (opts.force) return;
			throw new Error(`ENOENT: ${p}`);
		}
		if (this.isDir(p)) {
			const kids = [...this.nodes.keys()].filter(
				(k) => k.startsWith(`${p}/`) || (p === "/" && k !== "/"),
			);
			if (kids.length > 0 && !opts.recursive) throw new Error(`ENOTEMPTY: ${p}`);
			for (const k of kids) this.nodes.delete(k);
		}
		this.nodes.delete(p);
	}
	mv(src: string, dst: string): void {
		const n = this.nodes.get(src);
		if (n === undefined) throw new Error(`ENOENT: ${src}`);
		if (this.isDir(dst)) dst = `${dst}/${posix.basename(src)}`;
		this.rm(dst, { force: true });
		if ("dir" in n) {
			const kids = [...this.nodes.keys()].filter((k) => k.startsWith(`${src}/`));
			for (const k of kids) {
				const v = this.nodes.get(k)!;
				this.nodes.delete(k);
				this.nodes.set(`${dst}${k.slice(src.length)}`, v);
			}
		}
		this.nodes.delete(src);
		this.nodes.set(dst, n);
	}
	children(p: string): string[] {
		if (!this.isDir(p)) throw new Error(`ENOTDIR: ${p}`);
		const prefix = p === "/" ? "/" : `${p}/`;
		const out: string[] = [];
		for (const k of this.nodes.keys()) {
			if (k === p || !k.startsWith(prefix)) continue;
			const rest = k.slice(prefix.length);
			if (!rest.includes("/")) out.push(k);
		}
		return out.sort();
	}
	statLine(p: string): string {
		const n = this.nodes.get(p);
		if (n === undefined) throw new Error(`ENOENT: ${p}`);
		const kind =
			"dir" in n ? "directory" : n.data.length === 0 ? "regular empty file" : "regular file";
		const size = "dir" in n ? 0 : n.data.length;
		const mtime = "dir" in n ? 0 : Math.floor(n.mtime / 1000);
		return `${kind}|${size}|${mtime}`;
	}
	truncate(p: string, size: number): void {
		const cur = this.isFile(p) ? this.read(p) : new Uint8Array();
		const next = new Uint8Array(size);
		next.set(cur.slice(0, size));
		this.write(p, next);
	}
}

export interface MemSandbox extends Sandboxes {
	fs: MemFS;
	execGate: Promise<void> | null;
	sandboxDead: boolean;
	execCalls: number;
	dispatchCalls: number;
	cpGate: Promise<void> | null;
	cpCalls: number;
}

function shEval(script: string, fs: MemFS, cwd0: string): { out: string; code: number } {
	let cwd = cwd0;
	let out = "";
	let code = 0;
	const text = (s: string) => new TextEncoder().encode(s);

	function tokens(cmd: string): string[] {
		const t: string[] = [];
		let cur = "";
		let q: string | null = null;
		for (let i = 0; i < cmd.length; i++) {
			const c = cmd[i]!;
			if (q !== null) {
				if (c === q) q = null;
				else cur += c;
			} else if (c === "'" || c === '"') {
				q = c;
			} else if (c === " " || c === "\t") {
				if (cur !== "") {
					t.push(cur);
					cur = "";
				}
			} else {
				cur += c;
			}
		}
		if (cur !== "") t.push(cur);
		return t.map((x) => (x === "$?" ? String(code) : x));
	}

	function one(cmd: string): void {
		const t = tokens(cmd.trim());
		if (t.length === 0) return;
		let append = false;
		let redir: string | null = null;
		const args: string[] = [];
		for (let i = 0; i < t.length; i++) {
			const a = t[i]!;
			if (a === ">" || a === ">>") {
				append = a === ">>";
				redir = t[++i] ?? null;
			} else if (a === "<") {
				i++;
			} else {
				args.push(a);
			}
		}
		const [name, ...rest] = args;
		let local = "";
		const emit = (s: string) => {
			local += s;
		};
		const p = (x: string | undefined) => fs.norm(x ?? "", cwd);
		try {
			switch (name) {
				case "echo": {
					const n = rest[0] === "-n";
					emit(rest.slice(n ? 1 : 0).join(" ") + (n ? "" : "\n"));
					code = 0;
					break;
				}
				case "printf": {
					const fmt = rest[0] ?? "";
					emit(
						fmt
							.replace(/%s/g, () => rest[1] ?? "")
							.replace(/\\n/g, "\n")
							.replace(/\\0/g, "\0"),
					);
					code = 0;
					break;
				}
				case "cat": {
					const files = rest.filter((a) => a !== "--");
					for (const f of files) emit(new TextDecoder().decode(fs.read(p(f))));
					code = 0;
					break;
				}
				case "test": {
					const flag = rest[0];
					const target = p(rest[1] ?? "");
					code =
						flag === "-e" || flag === "-f" || flag === "-d" || flag === "-L"
							? flag === "-d"
								? fs.isDir(target)
									? 0
									: 1
								: flag === "-f"
									? fs.isFile(target)
										? 0
										: 1
									: fs.exists(target)
										? 0
										: 1
							: rest[1] === "="
								? rest[0] === rest[2]
									? 0
									: 1
								: 2;
					break;
				}
				case "true":
				case "sleep":
					code = 0;
					break;
				case "false":
					code = 1;
					break;
				case "exit":
					code = Number(rest[0] ?? 0) & 0xff;
					break;
				case "mkdir":
					fs.mkdir(p(rest.at(-1) ?? ""), rest.includes("-p"));
					code = 0;
					break;
				case "touch":
					if (!fs.exists(p(rest.at(-1) ?? ""))) fs.write(p(rest.at(-1)!), text(""));
					code = 0;
					break;
				case "rm":
					fs.rm(p(rest.at(-1) ?? ""), {
						recursive: rest.includes("-r") || rest.includes("-rf") || rest.includes("-fr"),
						force: rest.includes("-f") || rest.includes("-rf") || rest.includes("-fr"),
					});
					code = 0;
					break;
				case "mv":
					fs.mv(p(rest[0] ?? ""), p(rest[1] ?? ""));
					code = 0;
					break;
				case "ls":
					emit(
						fs
							.children(p(rest[0] ?? "."))
							.map((k) => posix.basename(k))
							.join("\n") + "\n",
					);
					code = 0;
					break;
				case "pwd":
					emit(`${cwd}\n`);
					code = 0;
					break;
				case "cd":
					if (rest[0] !== undefined) {
						const d = p(rest[0]);
						if (!fs.isDir(d)) {
							emit(`cd: ${rest[0]}: No such file or directory\n`);
							code = 1;
						} else {
							cwd = d;
							code = 0;
						}
					}
					break;
				case "seq": {
					const n = Number(rest.at(-1) ?? 1);
					for (let i = Number(rest.length > 1 ? rest[0] : 1); i <= n; i++) emit(`${i}\n`);
					code = 0;
					break;
				}
				case "head":
				case "tail": {
					const f = rest.at(-1) ?? "";
					const lines = new TextDecoder().decode(fs.read(p(f))).split("\n");
					const n = rest.includes("-n") ? Number(rest[rest.indexOf("-n") + 1]) : 10;
					emit(
						(name === "head" ? lines.slice(0, n) : lines.slice(-n)).join("\n") +
							(lines.at(-1) === "" ? "" : "\n"),
					);
					code = 0;
					break;
				}
				case "wc": {
					const f = p(rest.at(-1) ?? "");
					const data = fs.read(f);
					const nl = data.filter((b) => b === 10).length;
					emit(`${nl} ${data.length} ${f}\n`);
					code = 0;
					break;
				}
				case "basename":
					emit(`${posix.basename(rest[0] ?? "")}\n`);
					code = 0;
					break;
				case "dirname":
					emit(`${posix.dirname(rest[0] ?? "")}\n`);
					code = 0;
					break;
				case "uname":
					emit("Linux\n");
					code = 0;
					break;
				case "env":
				case "id":
					emit("\n");
					code = 0;
					break;
				case "sh":
				case "/bin/sh":
				case "bash": {
					const idx = rest.indexOf("-c");
					if (idx >= 0 && rest[idx + 1] !== undefined) {
						const inner = shEval(rest[idx + 1]!, fs, cwd);
						emit(inner.out);
						code = inner.code;
					} else {
						code = 0;
					}
					break;
				}
				default:
					emit(`sh: ${name}: not found\n`);
					code = 127;
			}
		} catch (err) {
			emit(`${name}: ${err instanceof Error ? err.message : String(err)}\n`);
			code = 1;
		}
		if (redir !== null && redir !== "") {
			try {
				fs.write(p(redir), text(local), append);
				local = "";
			} catch {
				code = 1;
			}
		}
		out += local;
	}

	const parts: { cmd: string; conn: string }[] = [];
	let cur = "";
	let q: string | null = null;
	for (let i = 0; i < script.length; i++) {
		const c = script[i]!;
		if (q !== null) {
			cur += c;
			if (c === q) q = null;
			continue;
		}
		if (c === "'" || c === '"') {
			q = c;
			cur += c;
			continue;
		}
		if (c === ";") {
			parts.push({ cmd: cur, conn: ";" });
			cur = "";
			continue;
		}
		if (c === "&" && script[i + 1] === "&") {
			parts.push({ cmd: cur, conn: "&&" });
			cur = "";
			i++;
			continue;
		}
		if (c === "|" && script[i + 1] === "|") {
			parts.push({ cmd: cur, conn: "||" });
			cur = "";
			i++;
			continue;
		}
		cur += c;
	}
	parts.push({ cmd: cur, conn: ";" });
	let lastConn = ";";
	for (const part of parts) {
		const skip = (lastConn === "&&" && code !== 0) || (lastConn === "||" && code === 0);
		lastConn = part.conn;
		if (skip || part.cmd.trim() === "") continue;
		one(part.cmd);
	}
	return { out, code };
}

export function fakeSandboxes(): MemSandbox {
	const fs = new MemFS();
	const enc = new TextEncoder();
	const fake: MemSandbox = {
		fs,
		execGate: null,
		sandboxDead: false,
		execCalls: 0,
		dispatchCalls: 0,
		cpGate: null,
		cpCalls: 0,
		exec: async (_conv, command, opts) => ({
			result: dispatchString(command, opts),
		}),
		execArgv: async (_conv, argv, opts) => {
			fake.execCalls++;
			if (argv[0] === "env") fake.dispatchCalls++;
			await gateOrAbort(opts.abortSignal);
			return { result: dispatchArgv(argv) };
		},
		execBytesArgv: async (_conv, argv, opts) => {
			await gateOrAbort(opts.abortSignal);
			const r = dispatchArgv(argv);
			return { result: { ...r, stdout: r.stdoutBytes ?? enc.encode(r.stdout) } };
		},
		cpIn: async (_conv, hostPath, containerPath) => {
			fake.cpCalls++;
			if (fake.cpGate !== null) await fake.cpGate;
			const dest = fs.norm(containerPath);
			fs.mkdir(posix.dirname(dest), true);
			fs.write(dest, new Uint8Array(readFileSync(hostPath)));
			return {};
		},
		catFile: async (_conv, path) => {
			const p = fs.norm(path);
			if (!fs.isFile(p)) throw new SandboxError(`${path} is not a regular file in the sandbox`);
			return { data: fs.read(p) };
		},
		setNetwork: async () => ({}),
		reset: async () => ({}),
	};

	async function gateOrAbort(signal: AbortSignal | undefined): Promise<void> {
		if (fake.execGate === null || fake.sandboxDead) return;
		await Promise.race([
			fake.execGate,
			new Promise<void>((res) => signal?.addEventListener("abort", () => res())),
		]);
	}
	function fail(msg: string, code = 1): ExecResult {
		return {
			stdout: "",
			stderr: msg,
			exitCode: code,
			timedOut: false,
			killed: false,
			truncated: false,
		};
	}
	function okOut(stdout: string): ExecResult {
		return { stdout, stderr: "", exitCode: 0, timedOut: false, truncated: false, killed: false };
	}
	function dispatchString(command: string, opts: { maxOutput: number }): ExecResult {
		const r = shEval(command, fs, "/work");
		return {
			stdout: r.out,
			stderr: "",
			exitCode: r.code,
			timedOut: false,
			killed: false,
			truncated: r.out.length > opts.maxOutput,
		};
	}
	function dispatchArgv(argv: string[]): ExecResult {
		try {
			const [cmd, ...rest] = argv;
			if (cmd === "env") {
				const shIdx = rest.indexOf("/bin/sh");
				if (shIdx < 0) return fail("env: unsupported", 127);
				const tag = rest[shIdx + 3];
				if (tag !== "goblin-sh" && tag !== "goblin-argv") {
					return fail("env: unexpected payload", 127);
				}
				const cwd = fs.norm(rest[shIdx + 4] ?? "/work");
				const outPath = fs.norm(rest[shIdx + 5] ?? "/tmp/x");
				const errPath = fs.norm(rest[shIdx + 6] ?? "/tmp/y");
				const rcPath = fs.norm(rest[shIdx + 7] ?? "/tmp/z");
				if (!fs.isDir(cwd)) return fail(`cd failed: ${cwd}`, 96);
				const tail = rest.slice(shIdx + 8);
				let r: { out: string; code: number };
				if (tag === "goblin-sh") {
					r = shEval(tail[0] ?? "", fs, cwd);
				} else {
					const program = tail[0] ?? "";
					const args = tail.slice(2);
					if (program === "echo" || program === "/bin/echo") {
						r = { out: `${args.join(" ")}\n`, code: 0 };
					} else if (program === "/bin/sh" || program === "sh" || program === "bash") {
						const idx = args.indexOf("-c");
						r = shEval(args[idx + 1] ?? "", fs, cwd);
					} else {
						return fail(`program not found: ${program}`, 97);
					}
				}
				const capBytes = Number(tail[1] ?? "0") * 512;
				let out = r.out;
				let exitCode = r.code;
				if (capBytes > 0 && out.length > capBytes) {
					out = out.slice(0, capBytes);
					exitCode = 153;
				}
				fs.write(outPath, enc.encode(out));
				fs.write(errPath, enc.encode(""));
				fs.write(rcPath, enc.encode(String(exitCode)));
				return okOut("");
			}
			if (cmd === "/bin/sh" && rest[0] === "-c") {
				const script = rest[1]!;
				const tag = rest[2];
				if (tag === "file-error") {
					const target = fs.norm(rest[3] ?? "");
					if (fs.isDir(target)) return fail("", 83);
					for (let parent = posix.dirname(target); parent !== "/"; parent = posix.dirname(parent)) {
						if (fs.exists(parent) && !fs.isDir(parent)) return fail("", 82);
					}
					return fail("", fs.exists(target) ? 1 : 80);
				}
				if (tag === "env") {
					const guest = fs.norm(rest[3] ?? "");
					const dest = fs.norm(rest[4] ?? "");
					fs.mkdir(posix.dirname(dest), true);
					fs.write(dest, fs.read(guest), script.includes(">>"));
					fs.rm(guest, { force: true });
					return okOut("");
				}
				if (tag === "ls") {
					const dir = fs.norm(rest[3] ?? "");
					if (!fs.exists(dir)) return fail(`no such directory: ${dir}`, 2);
					if (!fs.isDir(dir)) return fail(`not a directory: ${dir}`, 3);
					const chunks: string[] = [];
					for (const f of fs.children(dir)) {
						chunks.push(`${f}\0${fs.statLine(f)}\n\0`);
					}
					return okOut(chunks.join(""));
				}
				if (tag === "mk") {
					const prefix = rest[3] ?? "env";
					const suffix = rest[4] ?? "";
					const name = `/tmp/${prefix}.${Math.random().toString(16).slice(2, 8)}${suffix}`;
					fs.write(name, enc.encode(""));
					return okOut(`${name}\n`);
				}
				if (tag === "t") {
					const target = fs.norm(rest[3] ?? "");
					return {
						stdout: "",
						stderr: "",
						exitCode: fs.exists(target) ? 0 : 1,
						timedOut: false,
						killed: false,
						truncated: false,
					};
				}
				if (tag === "tail-bytes") {
					const keepFrom = Number(rest[3] ?? "1");
					const data = fs.read(fs.norm(rest[4] ?? ""));
					const headCap = Number(rest[5] ?? "0");
					let pos = 0;
					for (let line = 1; line < keepFrom; line++) {
						const nl = data.indexOf(10, pos);
						if (nl === -1) {
							pos = data.length;
							break;
						}
						pos = nl + 1;
					}
					return okOut(String(Math.min(data.length - pos, headCap)));
				}
				if (tag === "merge-spill") {
					const outData = fs.read(fs.norm(rest[3] ?? ""));
					const errData = fs.read(fs.norm(rest[4] ?? ""));
					fs.write(fs.norm(rest[5] ?? ""), new Uint8Array([...outData, ...errData]));
					return okOut("");
				}
				if (tag === "ls-names") {
					const dir = fs.norm(rest[3] ?? "");
					if (!fs.exists(dir)) return fail(`no such directory: ${dir}`, 2);
					if (!fs.isDir(dir)) return fail(`not a directory: ${dir}`, 3);
					return okOut(
						fs
							.children(dir)
							.map((f) => `${f}\0`)
							.join(""),
					);
				}
				if (tag === "stat-batch") {
					const out: string[] = [];
					for (const name of rest.slice(3)) {
						const f = fs.norm(name);
						out.push(fs.exists(f) ? `${name}\0${fs.statLine(f)}\0` : `${name}\0MISSING\0`);
					}
					return okOut(out.join(""));
				}
				const r = shEval(script, fs, "/work");
				return {
					stdout: r.out,
					stderr: "",
					exitCode: r.code,
					timedOut: false,
					killed: false,
					truncated: false,
				};
			}
			const p = (x: string | undefined) => fs.norm(x ?? "");
			switch (cmd) {
				case "cat":
					return okOut(new TextDecoder().decode(fs.read(p(rest.at(-1)))));
				case "stat": {
					const target = p(rest.at(-1));
					if (!fs.exists(target))
						return fail(`stat: cannot statx '${rest.at(-1)}': No such file or directory`, 1);
					const fmtIdx = rest.indexOf("-c");
					if (fmtIdx >= 0 && rest[fmtIdx + 1] === "%F") {
						const kind = fs.isDir(target)
							? "directory"
							: fs.read(target).length === 0
								? "regular empty file"
								: "regular file";
						return okOut(`${kind}\n`);
					}
					return okOut(`${fs.statLine(target)}\n`);
				}
				case "mkdir":
					fs.mkdir(p(rest.at(-1)), rest.includes("-p"));
					return okOut("");
				case "mv": {
					const operands = rest.filter((a) => a !== "--" && !a.startsWith("-"));
					fs.mv(p(operands[0]), p(operands[1]));
					return okOut("");
				}
				case "rm":
					for (const f of rest.filter((a) => !a.startsWith("-") && a !== "--")) {
						fs.rm(p(f), {
							recursive: rest.some((a) => a.includes("r")),
							force: rest.some((a) => a.includes("f")),
						});
					}
					return okOut("");
				case "truncate": {
					const size = Number(rest[rest.indexOf("-s") + 1] ?? "0");
					fs.truncate(p(rest.at(-1)), size);
					return okOut("");
				}
				case "realpath":
					if (!fs.exists(p(rest.at(-1))))
						return fail(`realpath: ${rest.at(-1)}: No such file or directory`, 1);
					return okOut(`${p(rest.at(-1))}\n`);
				case "mktemp": {
					if (rest[0] === "-d") {
						const name = (rest[1] ?? "/tmp/x").replace(/X+$/, () =>
							Math.random().toString(16).slice(2, 8),
						);
						fs.mkdir(name, true);
						return okOut(`${name}\n`);
					}
					const name = (rest[0] ?? "/tmp/x").replace(/X+$/, () =>
						Math.random().toString(16).slice(2, 8),
					);
					fs.write(name, enc.encode(""));
					return okOut(`${name}\n`);
				}
				case "sync":
					return okOut("");
				case "wc": {
					const files = rest.filter((a) => !a.startsWith("-") && a !== "--");
					if (files.length === 0) return okOut("0 0\n");
					let totalLines = 0;
					let totalBytes = 0;
					const rows: string[] = [];
					for (const f of files) {
						const data = fs.read(p(f));
						const nl = data.filter((b) => b === 10).length;
						rows.push(`${nl} ${data.length} ${p(f)}`);
						totalLines += nl;
						totalBytes += data.length;
					}
					if (files.length > 1) rows.push(`${totalLines} ${totalBytes} total`);
					return okOut(`${rows.join("\n")}\n`);
				}
				case "dd": {
					const ifArg = rest.find((a) => a.startsWith("if="))?.slice(3) ?? "";
					const skip = Number(rest.find((a) => a.startsWith("skip="))?.slice(5) ?? "0");
					const count = Number(rest.find((a) => a.startsWith("count="))?.slice(6) ?? "0");
					const data = fs.read(p(ifArg));
					return { ...okOut(""), stdoutBytes: data.slice(skip, skip + count) };
				}
				case "ln": {
					const src = p(rest[0]);
					if (!fs.exists(src)) return fail(`ln: ${rest[0]}: No such file or directory`, 1);
					fs.write(p(rest[1]), fs.read(src));
					return okOut("");
				}
				case "tail": {
					const n = rest.includes("-c") ? Number(rest[rest.indexOf("-c") + 1]) : 10 * 1024;
					const data = fs.read(p(rest.at(-1)));
					return okOut(new TextDecoder().decode(data.slice(-n)));
				}
				case "test": {
					const f = p(rest.at(-1));
					const flag = rest[0];
					const hit = flag === "-d" ? fs.isDir(f) : flag === "-f" ? fs.isFile(f) : fs.exists(f);
					return {
						stdout: "",
						stderr: "",
						exitCode: hit ? 0 : 1,
						timedOut: false,
						killed: false,
						truncated: false,
					};
				}
				default:
					return fail(`${cmd}: not found`, 127);
			}
		} catch (err) {
			return fail(err instanceof Error ? err.message : String(err));
		}
	}
	return fake;
}

export interface FakeDesktops extends Desktops {
	actCalls: number;
	claimCalls: number;
	claimWaiting: number;
	held: Map<string, LeaseHolder>;
	actGate: Promise<void> | null;
	claimGate: Promise<void> | null;
}

export function fakeDesktops(): FakeDesktops {
	const rows = new Map<string, DesktopRow>();
	const held = new Map<string, LeaseHolder>();
	const f: FakeDesktops = {
		actCalls: 0,
		claimCalls: 0,
		claimWaiting: 0,
		held,
		actGate: null,
		claimGate: null,
		allocate: async (name) => {
			const row: DesktopRow = {
				name,
				container: `fake-${name}`,
				image: "fake",
				network: false,
				reserved: false,
				leaseKind: null,
				leaseId: null,
				leaseExpiresAt: null,
				lastObsId: null,
				lastObsUsed: false,
				lastObsHash: null,
				lastActSig: null,
				lastActFrameHash: null,
				shotSeq: 0,
				createdAt: Date.now(),
				lastUsedAt: Date.now(),
			};
			rows.set(name, row);
			return { row };
		},
		list: () => [...rows.values()],
		get: (name) => rows.get(name) ?? null,
		claim: async (name, holder) => {
			f.claimWaiting++;
			try {
				if (f.claimGate !== null) await f.claimGate;
			} finally {
				f.claimWaiting--;
			}
			f.claimCalls++;
			const row = rows.get(name);
			if (row === undefined) throw new DesktopError(`no desktop named ${name}`);
			const live = held.get(name);
			if (
				live !== undefined &&
				(live.kind !== holder.kind || ("id" in live && "id" in holder && live.id !== holder.id))
			) {
				throw new DesktopLeaseError(
					`desktop ${name} is controlled by ${live.kind}${"id" in live ? ` ${live.id}` : ""}`,
				);
			}
			held.set(name, holder);
			row.leaseKind = holder.kind;
			row.leaseId = "id" in holder ? holder.id : null;
			row.leaseExpiresAt = Date.now() + 60_000;
			return row;
		},
		release: async (name, holder) => {
			const live = held.get(name);
			if (
				live !== undefined &&
				live.kind === holder.kind &&
				(!("id" in live) || !("id" in holder) || live.id === holder.id)
			) {
				held.delete(name);
			}
			const row = rows.get(name);
			if (row !== undefined) {
				row.leaseKind = null;
				row.leaseId = null;
				row.leaseExpiresAt = null;
			}
		},
		handoff: async () => {},
		reserve: async () => {},
		setNetwork: async () => {},
		destroy: async () => {},
		screenshot: async (name) => ({
			id: `obs-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
			path: `/tmp/fake-${name}.png`,
			bytes: new Uint8Array([137, 80, 78, 71]),
		}),
		inspect: async (name, opts) => ({
			id: `obs-i-${Date.now()}`,
			state: { windows: 1, ...(opts ?? {}) },
		}),
		act: async (name, holder, _obs, _action: DesktopAction) => {
			f.actCalls++;
			if (f.actGate !== null) await f.actGate;
			return { result: { effect: "dispatched" } };
		},
		cpIn: async () => ({}),
		catFile: async () => ({ data: new Uint8Array([1]) }),
	};
	return f;
}

export const WS = "conv:test";

export let dirs: string[] = [];
export let servers: FakeModel[] = [];
export let owners: Subagents[] = [];
let runStores: SubagentRuns[] = [];

afterEach(async () => {
	// Owner close is async — deleting the temp dirs under an in-flight
	// close races the drain into removed paths.
	await Promise.allSettled(owners.map((o) => o.close()));
	owners = [];
	for (const r of runStores) r.close();
	runStores = [];
	for (const s of servers) s.close();
	servers = [];
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

export function forgetOwner(o: Subagents): void {
	owners = owners.filter((x) => x !== o);
}

export function openRunStore(dbPath: string): SubagentRuns {
	const runs = openSubagentRuns(dbPath);
	runStores.push(runs);
	return runs;
}

function makeConfig(url: string, overrides?: Partial<SubagentsConfig>): SubagentsConfig {
	return {
		maxRuns: 3,
		worker: {
			model: {
				auth: "test",
				id: "glm-5.3",
				baseUrl: url,
				api: "openai-completions",
				thinking: "low",
			},
		},
		computer: {
			model: {
				auth: "test",
				id: "glm-5.3-flash",
				baseUrl: url,
				api: "openai-completions",
				thinking: "low",
			},
		},
		desktops: {
			image: "localhost/goblin-desktop:1",
			max: 3,
			idleHours: 0,
			memory: "1g",
			cpus: 1,
			pids: 16,
		},
		...overrides,
	};
}

export interface Rig {
	owner: Subagents;
	runs: SubagentRuns;
	model: FakeModel;
	box: MemFS;
	workspace: string;
	storagePath: string;
	dbPath: string;
	wakes: { conv: string; text: string }[];
	desktops: FakeDesktops;
	sandboxes: MemSandbox;
	resume: boolean;
	authCalls: number;
}

const ready = new WeakMap<Rig, Promise<Subagents>>();

export function rig(opts?: {
	wakeOk?: () => boolean;
	desktops?: FakeDesktops;
	sandboxes?: MemSandbox;
	maxRuns?: number;
	resume?: boolean;
	reuse?: { dbPath: string; storagePath: string };
	model?: FakeModel;
	wakeFn?: (conv: string, text: string) => boolean;
	configOverrides?: Partial<SubagentsConfig>;
	modelProfiles?: Partial<Record<"worker" | "computer", SubagentModelProfile>>;
	harnessSettings?: Record<string, unknown>;
	admitRetryMs?: number;
}): Rig {
	const dir = mkdtempSync(join(tmpdir(), "goblin-sub-"));
	dirs.push(dir);
	const workspace = join(dir, "ws");
	mkdirSync(workspace, { recursive: true });
	const model = opts?.model ?? startFakeModel();
	if (opts?.model === undefined) servers.push(model);
	const dbPath = opts?.reuse?.dbPath ?? join(dir, "goblin.sqlite");
	const storagePath = opts?.reuse?.storagePath ?? join(dir, "subagents.sqlite");
	const runs = openSubagentRuns(dbPath);
	runStores.push(runs);
	const wakes: { conv: string; text: string }[] = [];
	const desktops = opts?.desktops ?? fakeDesktops();
	const sandboxes = opts?.sandboxes ?? fakeSandboxes();
	const config = makeConfig(model.url, {
		...(opts?.maxRuns ? { maxRuns: opts.maxRuns } : {}),
		...opts?.configOverrides,
	});
	const r: Rig = {
		owner: undefined as unknown as Subagents,
		runs,
		model,
		box: sandboxes.fs,
		workspace,
		storagePath,
		dbPath,
		wakes,
		desktops,
		sandboxes,
		resume: opts?.resume ?? true,
		authCalls: 0,
	};
	const p = openSubagents({
		config,
		runs,
		auth: {
			resolve: async () => {
				r.authCalls++;
				return "fake-key";
			},
		},
		sandboxes,
		desktops,
		storagePath,
		transferRoot: join(dir, "transfer"),
		wake: (conv, text) => {
			if (opts?.wakeFn !== undefined) return opts.wakeFn(conv, text);
			const ok = opts?.wakeOk ? opts.wakeOk() : true;
			if (ok) wakes.push({ conv, text });
			return ok;
		},
		...(opts?.modelProfiles !== undefined ? { modelProfiles: opts.modelProfiles } : {}),
		...(opts?.harnessSettings !== undefined ? { harnessSettings: opts.harnessSettings } : {}),
		...(opts?.admitRetryMs !== undefined ? { admitRetryMs: opts.admitRetryMs } : {}),
	}).then(async (owner) => {
		owners.push(owner);
		r.owner = owner;
		if (r.resume) await owner.resume();
		return owner;
	});
	ready.set(r, p);
	return r;
}

export async function open(r: Rig): Promise<Subagents> {
	return await ready.get(r)!;
}

export async function until(
	fn: () => boolean | Promise<boolean>,
	what: string,
	ms = 20_000,
): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await fn()) return;
		await Bun.sleep(40);
	}
	throw new Error(`timed out waiting for: ${what}`);
}

export function armSubmitFault(
	holdRetry?: Promise<void>,
	loseAck = false,
): { arm: () => void; restore: () => void } {
	const origOpen = Harness.open;
	let armed = false;
	Harness.open = (async (...args: Parameters<typeof Harness.open>) => {
		const h = await origOpen(...args);
		const origConversation = h.conversation.bind(h) as (...cArgs: unknown[]) => Promise<unknown>;
		(h as unknown as { conversation: unknown }).conversation = async (...cArgs: unknown[]) => {
			const conv = await origConversation(...cArgs);
			if (conv === undefined || conv === null || !armed) return conv;
			const target = conv as {
				submit: (...sArgs: unknown[]) => Promise<unknown>;
			};
			const origSubmit = target.submit.bind(target);
			target.submit = async (...sArgs: unknown[]) => {
				if (!armed) {
					if (holdRetry !== undefined) await holdRetry;
					return origSubmit(...sArgs);
				}
				armed = false;
				if (loseAck) await origSubmit(...sArgs);
				throw new Error("injected transient submit failure");
			};
			return conv;
		};
		return h;
	}) as typeof Harness.open;
	return {
		arm: () => (armed = true),
		restore: () => {
			armed = false;
			Harness.open = origOpen;
		},
	};
}

export function armConversationFaults(): {
	submitArmed: boolean;
	abortArmed: boolean;
	abortHold: Promise<void> | null;
	abortEntered: Promise<void>;
	releaseAbort: () => void;
	restore: () => void;
} {
	const origOpen = Harness.open;
	const faults = {
		submitArmed: false,
		abortArmed: false,
		abortHold: null as Promise<void> | null,
	};
	const abortGate = Promise.withResolvers<void>();
	const abortEntered = Promise.withResolvers<void>();
	Harness.open = (async (...args: Parameters<typeof Harness.open>) => {
		const h = await origOpen(...args);
		const origConversation = h.conversation.bind(h) as (...cArgs: unknown[]) => Promise<unknown>;
		(h as unknown as { conversation: unknown }).conversation = async (...cArgs: unknown[]) => {
			const conv = await origConversation(...cArgs);
			if (conv === undefined || conv === null) return conv;
			const target = conv as {
				submit: (...sArgs: unknown[]) => Promise<unknown>;
				abort: (...aArgs: unknown[]) => Promise<unknown>;
			};
			const origSubmit = target.submit.bind(target);
			const origAbort = target.abort.bind(target);
			target.submit = async (...sArgs: unknown[]) => {
				if (faults.submitArmed) throw new Error("injected persistent submit failure");
				return origSubmit(...sArgs);
			};
			target.abort = async (...aArgs: unknown[]) => {
				if (faults.abortHold !== null) {
					abortEntered.resolve();
					await faults.abortHold;
				}
				if (faults.abortArmed) throw new Error("injected abort failure");
				return origAbort(...aArgs);
			};
			return conv;
		};
		return h;
	}) as typeof Harness.open;
	return {
		get submitArmed() {
			return faults.submitArmed;
		},
		set submitArmed(v: boolean) {
			faults.submitArmed = v;
		},
		get abortArmed() {
			return faults.abortArmed;
		},
		set abortArmed(v: boolean) {
			faults.abortArmed = v;
		},
		get abortHold() {
			return faults.abortHold;
		},
		set abortHold(v: Promise<void> | null) {
			faults.abortHold = v;
		},
		abortEntered: abortEntered.promise,
		releaseAbort: () => abortGate.resolve(),
		restore: () => {
			abortGate.resolve();
			Harness.open = origOpen;
		},
	};
}

export function armSubmissionWaitFault(): { armed: boolean; restore: () => void } {
	const origOpen = Harness.open;
	const state = { armed: true };
	const wrap = (sub: unknown): unknown => {
		if (sub === undefined || sub === null) return sub;
		const target = sub as {
			id: unknown;
			status: (...sArgs: unknown[]) => Promise<unknown>;
			wait: (...wArgs: unknown[]) => Promise<unknown>;
			abort: (...aArgs: unknown[]) => Promise<unknown>;
		};
		const realWait = target.wait.bind(target);
		return {
			id: target.id,
			status: target.status.bind(target),
			abort: target.abort.bind(target),
			wait: async (...wArgs: unknown[]) => {
				if (state.armed) throw new Error("injected submission wait failure");
				return realWait(...wArgs);
			},
		};
	};
	Harness.open = (async (...args: Parameters<typeof Harness.open>) => {
		const h = await origOpen(...args);
		const origSubmission = h.submission;
		h.submission = (async (...sArgs: unknown[]) =>
			wrap(
				await (origSubmission as (...a: unknown[]) => Promise<unknown>).apply(h, sArgs),
			)) as typeof h.submission;
		const origConversation = h.conversation.bind(h) as (...cArgs: unknown[]) => Promise<unknown>;
		(h as unknown as { conversation: unknown }).conversation = async (...cArgs: unknown[]) => {
			const conv = await origConversation(...cArgs);
			if (conv === undefined || conv === null) return conv;
			const target = conv as { submit: (...sArgs: unknown[]) => Promise<unknown> };
			const origSubmit = target.submit.bind(target);
			target.submit = async (...sArgs: unknown[]) => wrap(await origSubmit(...sArgs));
			return conv;
		};
		return h;
	}) as typeof Harness.open;
	return {
		get armed() {
			return state.armed;
		},
		set armed(v: boolean) {
			state.armed = v;
		},
		restore: () => {
			Harness.open = origOpen;
		},
	};
}

export const HAIKU_PROFILE: SubagentModelProfile = subagentModelProfileSchema.parse({
	id: "claude-haiku-5.5:free",
	input: ["text", "image"],
	reasoning: true,
	contextWindow: 1000000,
	maxTokens: 16384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
	},
});

export function haikuConfig(kind: "worker" | "computer", url: string): SubagentsConfig["worker"] {
	return {
		model: {
			auth: "test",
			id: "claude-haiku-5.5:free",
			baseUrl: url,
			api: "openai-completions",
			thinking: "off",
		},
	};
}
