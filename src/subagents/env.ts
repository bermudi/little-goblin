import { Buffer } from "node:buffer";
import { mkdirSync, rmSync } from "node:fs";
import { basename, join, posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import type {
	BinaryReader,
	DirReader,
	ExecutionEnv,
	ExecutionError,
	FileInfo,
	FileWatcher,
	LineScan,
	Result,
	ShellExecOptions,
	ShellExecResult,
	ShellOutputInfo,
	TextLine,
	TextLineReader,
	WatchChange,
	WatchTarget,
} from "@earendil-works/pi-durable/env";
import {
	err,
	FileError,
	LineScanner,
	ok,
	ExecutionError as PiExecutionError,
} from "@earendil-works/pi-durable/env";
import { log } from "../log.ts";
import type { Sandboxes } from "../sandboxes.ts";

const READ_CAP = 100 * 1024 * 1024;
const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;
const WATCH_POLL_MS = 500;
const SHELL_TIMEOUT_DEFAULT_S = 60;
const SHELL_TIMEOUT_CAP_S = 600;
const SPILL_CAP_BYTES = 100 * 1024 * 1024;

// The wrapper's own exit status is reserved for start failures (96 =
// cd failed, 97 = program missing); the command's own exit code exists
// only in the rc file, so an exit 96/97 or 125–127 can't be misread.
const EXEC_SH_SCRIPT =
	'cd "$1" || { echo "cd failed: $1" >&2; exit 96; }; ( ulimit -f "$6" 2>/dev/null; /bin/sh -c "$5" >"$2" 2>"$3"; printf %s "$?" >"$4" )';
const EXEC_ARGV_SCRIPT =
	'cd "$1" || { echo "cd failed: $1" >&2; exit 96; }; p="$5"; command -v "$p" >/dev/null 2>&1 || { echo "program not found: $p" >&2; exit 97; }; cap="$6"; out="$2"; err="$3"; rc="$4"; shift 6; ( ulimit -f "$cap" 2>/dev/null; "$p" "$@" >"$out" 2>"$err"; printf %s "$?" >"$rc" )';

type StreamMeasure = { path: string; bytes: number; newlines: number };
type TailWindow = { maxBytes: number; maxLines: number };
type StreamDelivery = { kind: "ok" } | { kind: "aborted" } | { kind: "failed"; message: string };

function finiteFloor(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

export class SandboxEnv implements ExecutionEnv {
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
		// Classification uses only the probe's exit statuses — never
		// filenames or localized command diagnostics.
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
	// openBinaryReader must keep reading its opened file after a rename, and
	// no guest process can hold an fd across podman execs — a hidden hardlink
	// pins the inode; on link failure reads fall back to the path (warned).
	private async pinFile(
		path: string,
		abs: string,
		context: Context,
	): Promise<Result<{ readPath: string; pinPath: string | null }, FileError>> {
		const pinPath = `${posix.dirname(abs)}/.goblin-br-${Math.random().toString(16).slice(2)}`;
		const link = await this.run(["ln", abs, pinPath], undefined, context);
		if (!link.timedOut && link.exitCode === 0) {
			return ok({ readPath: pinPath, pinPath });
		}
		if (context.abortSignal?.aborted) return aborted();
		log.warn("sandbox binary reader unpinned", {
			conversation: this.origin,
			path: abs,
			exitCode: link.exitCode,
			timedOut: link.timedOut,
			stderr: link.stderr.trim().slice(0, 200),
		});
		return ok({ readPath: abs, pinPath: null });
	}
	private async readBytesAt(
		readPath: string,
		offset: number,
		length: number,
		path: string,
		context: Context,
	): Promise<Result<Uint8Array, FileError>> {
		const { result } = await this.sandboxes.execBytesArgv(
			this.origin,
			[
				"dd",
				`if=${readPath}`,
				"iflag=skip_bytes,count_bytes",
				`skip=${offset}`,
				`count=${length}`,
				"bs=1M",
			],
			{
				timeoutMs: 120_000,
				maxOutput: length + 4096,
				...(context.abortSignal !== undefined ? { abortSignal: context.abortSignal } : {}),
			},
		);
		if (result.timedOut) return envErr("unknown", `${path}: read timed out`, path);
		if (context.abortSignal?.aborted) return aborted();
		if (result.truncated) {
			return envErr("unknown", `${path}: read exceeded the transfer bound`, path);
		}
		if (result.exitCode !== 0) {
			return envErr(await this.fileError(path, context), `${path}: ${result.stderr.trim()}`, path);
		}
		return ok<Uint8Array, FileError>(result.stdout);
	}
	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		if (context.abortSignal?.aborted) return aborted();
		const abs = this.resolve(path);
		const kindOut = await this.runOut(
			options?.noFollow ? ["stat", "-c", "%F", "--", abs] : ["stat", "-L", "-c", "%F", "--", abs],
			path,
			context,
		);
		if (!kindOut.ok) return kindOut;
		const kind = FILE_KINDS.get(kindOut.value.trim());
		if (kind === "directory") return envErr("is_directory", `${path} is a directory`, path);
		if (kind !== "file") {
			return envErr("invalid", `${path} is not a regular file`, path);
		}
		const pin = await this.pinFile(path, abs, context);
		if (!pin.ok) return pin;
		const readPath = pin.value.readPath;
		const pinPath = pin.value.pinPath;
		if (context.abortSignal?.aborted) {
			if (pinPath !== null) await this.guestRm([pinPath]);
			return aborted();
		}
		let closed = false;
		const reader: BinaryReader = {
			info: async (rctx) => {
				if (rctx.abortSignal?.aborted) return aborted();
				if (closed) return envErr("invalid", `${path}: reader is closed`, path);
				const st = await this.runOut(["stat", "-L", "-c", "%F|%s|%Y", "--", readPath], path, rctx);
				if (!st.ok) return st;
				const parsed = this.parseStat(st.value, path);
				if (!parsed.ok) return parsed;
				return ok<FileInfo, FileError>({ name: basename(abs), path: abs, ...parsed.value });
			},
			read: async (offset, length, rctx) => {
				if (rctx.abortSignal?.aborted) return aborted();
				if (closed) return envErr("invalid", `${path}: reader is closed`, path);
				if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) {
					return envErr(
						"invalid",
						`${path}: read(${offset}, ${length}) needs non-negative integer offset and length`,
						path,
					);
				}
				if (length === 0) return ok<Uint8Array, FileError>(new Uint8Array());
				return this.readBytesAt(readPath, offset, length, path, rctx);
			},
			scanLines: async (scan, rctx) => {
				if (rctx.abortSignal?.aborted) return aborted();
				if (closed) return envErr("invalid", `${path}: reader is closed`, path);
				const { startLine, endLine } = scan;
				if (
					!Number.isInteger(startLine) ||
					startLine < 0 ||
					(endLine !== undefined && (!Number.isInteger(endLine) || endLine <= startLine))
				) {
					return envErr(
						"invalid",
						`${path}: scanLines(${startLine}, ${endLine ?? "end"}) is not a line range`,
						path,
					);
				}
				const scanner = new LineScanner(startLine, endLine);
				let pos = 0;
				for (;;) {
					const chunk = await this.readBytesAt(readPath, pos, SCAN_CHUNK_BYTES, path, rctx);
					if (!chunk.ok) return chunk;
					if (chunk.value.length > 0) scanner.push(chunk.value);
					pos += chunk.value.length;
					if (chunk.value.length < SCAN_CHUNK_BYTES) break;
				}
				return ok<LineScan, FileError>(scanner.finish());
			},
			close: async () => {
				if (closed) return;
				closed = true;
				if (pinPath !== null) await this.guestRm([pinPath]);
			},
		};
		return ok<BinaryReader, FileError>(reader);
	}
	private async statEntries(
		batch: string[],
		path: string,
		context: Context,
	): Promise<Result<Array<FileInfo | null>, FileError>> {
		const out = await this.runOut(
			[
				"/bin/sh",
				"-c",
				'for f in "$@"; do if s=$(stat -c "%F|%s|%Y" -- "$f" 2>/dev/null); then printf "%s\\0%s\\0" "$f" "$s"; else printf "%s\\0MISSING\\0" "$f"; fi; done',
				"stat-batch",
				...batch,
			],
			path,
			context,
		);
		if (!out.ok) return out;
		const fields = out.value.split("\0");
		const entries: Array<FileInfo | null> = [];
		for (let i = 0; i + 1 < fields.length; i += 2) {
			const name = fields[i]!;
			const raw = fields[i + 1]!;
			if (raw === "MISSING") {
				entries.push(null);
				continue;
			}
			const parsed = this.parseStat(raw, name);
			if (!parsed.ok) {
				if (parsed.error.code === "not_supported") {
					entries.push(null);
					continue;
				}
				return parsed;
			}
			entries.push({ name: basename(name), path: name, ...parsed.value });
		}
		return ok(entries);
	}
	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		if (context.abortSignal?.aborted) return aborted();
		const abs = this.resolve(path);
		const out = await this.runOut(
			[
				"/bin/sh",
				"-c",
				'if [ ! -d "$1" ]; then if [ -e "$1" ] || [ -L "$1" ]; then printf "not a directory: %s\\n" "$1" >&2; exit 3; else printf "no such directory: %s\\n" "$1" >&2; exit 2; fi; fi; for f in "$1"/.[!.]* "$1"/..?* "$1"/*; do [ -e "$f" ] || [ -L "$f" ] || continue; printf "%s\\0" "$f"; done',
				"ls-names",
				abs,
			],
			path,
			context,
			{ 2: "not_found", 3: "not_directory" },
		);
		if (!out.ok) return out;
		if (context.abortSignal?.aborted) return aborted();
		const names = out.value === "" ? [] : out.value.split("\0");
		if (names[names.length - 1] === "") names.pop();
		let next = 0;
		let done = false;
		let closed = false;
		return ok<DirReader, FileError>({
			next: async (maxEntries, rctx) => {
				if (rctx.abortSignal?.aborted) return aborted();
				if (closed) return envErr("invalid", `${path}: reader is closed`, path);
				if (!Number.isInteger(maxEntries) || maxEntries < 1) {
					return envErr(
						"invalid",
						`${path}: next(${maxEntries}) needs a page size of at least 1`,
						path,
					);
				}
				if (done) return ok({ entries: [], done: true });
				const batch = names.slice(next, next + maxEntries);
				next += batch.length;
				const entries: FileInfo[] = [];
				if (batch.length > 0) {
					const scanned = await this.statEntries(batch, path, rctx);
					if (!scanned.ok) return scanned;
					for (const info of scanned.value) {
						if (info !== null) entries.push(info);
					}
				}
				if (next >= names.length) done = true;
				return ok({ entries, done });
			},
			close: async () => {
				closed = true;
			},
		});
	}
	// `%y` (nanosecond mtime) catches a same-size rewrite inside one
	// poll; links below a directory are listed, never followed.
	private async targetSnapshot(
		abs: string,
		recursive: boolean,
		exclude: WatchTarget["exclude"],
		context: Context,
	): Promise<Result<string, FileError>> {
		const out = await this.runOut(
			[
				"/bin/sh",
				"-c",
				`p=$(readlink -f "$1"); printf "%s\\n" "$p"; if [ ! -e "$p" ] && [ ! -L "$p" ]; then printf "MISSING\\n"; exit 0; fi; if [ -d "$p" ]; then find "$p" ${recursive ? "" : "-maxdepth 1 "}-exec stat -c "%F|%s|%y|%n" {} +; else stat -L -c "%F|%s|%y|%n" "$p" 2>/dev/null || stat -c "%F|%s|%y|%n" "$p"; fi`,
				"snapshot",
				abs,
			],
			abs,
			context,
		);
		if (!out.ok) return out;
		const lines = out.value.split("\n");
		const root = lines.shift() ?? "";
		const hidden = exclude?.hidden === true;
		const names = new Set(exclude?.names ?? []);
		const kept: string[] = [];
		for (const line of lines) {
			if (line === "") continue;
			if (line === "MISSING") {
				kept.push(line);
				continue;
			}
			let at = -1;
			for (let k = 0; k < 3; k++) at = line.indexOf("|", at + 1);
			const name = at === -1 ? line : line.slice(at + 1);
			const rel =
				name === root ? "" : name.startsWith(`${root}/`) ? name.slice(root.length + 1) : name;
			if (rel !== "") {
				const segments = rel.split("/");
				if (hidden && segments.some((s) => s.startsWith("."))) continue;
				if (names.size > 0 && segments.some((s) => names.has(s))) continue;
			}
			kept.push(line);
		}
		return ok<string, FileError>(kept.join("\n"));
	}
	async watch(
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		if (context.abortSignal?.aborted) return aborted();
		// Polling: the sandbox fs is reached only through one-shot podman
		// execs, so there is no live event stream — a change undone
		// between two snapshots can be missed.
		const plans = targets.map((t) => ({
			abs: this.resolve(t.path),
			recursive: t.recursive === true,
			exclude: t.exclude,
			state: null as string | null,
			owed: true,
		}));
		for (const plan of plans) {
			const snap = await this.targetSnapshot(plan.abs, plan.recursive, plan.exclude, context);
			if (context.abortSignal?.aborted) return aborted();
			if (snap.ok) {
				plan.state = snap.value;
				plan.owed = false;
			}
		}
		let closed = false;
		let running: Promise<void> | null = null;
		const emit = (change: WatchChange): void => {
			if (closed || context.abortSignal?.aborted === true) return;
			try {
				onChange(change);
			} catch (error) {
				log.warn("sandbox watch callback failed", error, { conversation: this.origin });
			}
		};
		const tick = async (): Promise<void> => {
			for (const plan of plans) {
				if (closed) return;
				const snap = await this.targetSnapshot(plan.abs, plan.recursive, plan.exclude, context);
				if (closed) return;
				if (!snap.ok) {
					if (plan.state !== null) emit({ overflow: true });
					else plan.owed = true;
					plan.state = null;
					continue;
				}
				if (plan.state === null) {
					plan.state = snap.value;
					if (plan.owed) {
						plan.owed = false;
						emit({ overflow: true });
					}
					continue;
				}
				if (plan.state !== snap.value) {
					plan.state = snap.value;
					emit({ paths: [plan.abs] });
				}
			}
		};
		const timer = setInterval(() => {
			if (closed || context.abortSignal?.aborted === true || running !== null) return;
			running = tick()
				.catch((error) =>
					log.warn("sandbox watch poll failed", error, { conversation: this.origin }),
				)
				.finally(() => {
					running = null;
				});
		}, WATCH_POLL_MS);
		return ok<FileWatcher, FileError>({
			mode: "polling",
			close: async () => {
				closed = true;
				clearInterval(timer);
				await running;
			},
		});
	}
	private async stage(
		content: string | Uint8Array,
		destScript: string,
		path: string,
		context: Context,
	): Promise<Result<void, FileError>> {
		if (context.abortSignal?.aborted) return aborted();
		// Content never enters argv: it is staged on the host, cpIn'd,
		// then moved by an in-guest shell op.
		mkdirSync(this.transferRoot, { recursive: true });
		const staged = join(
			this.transferRoot,
			`w-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		);
		const guest = `${STAGE}-${Math.random().toString(16).slice(2)}`;
		let cleanup: string | null = null;
		try {
			if (context.abortSignal?.aborted) return aborted();
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
	// A trimmed chunk must exceed the window by a byte or a line —
	// OutputBuffer's skip requirement — and its cut is fenced back onto
	// a character boundary; skipped bytes count decoded text.
	private async deliverStream(
		rec: StreamMeasure,
		stream: "stdout" | "stderr",
		window: TailWindow | undefined,
		onOutput: (text: string, context: Context, info: ShellOutputInfo) => void,
		context: Context,
	): Promise<StreamDelivery> {
		if (rec.bytes === 0) return { kind: "ok" };
		let start = 0;
		let omittedLast: number | null = null;
		if (
			window !== undefined &&
			(rec.bytes > window.maxBytes + 1 || rec.newlines > window.maxLines)
		) {
			if (rec.bytes > window.maxBytes + 1) start = rec.bytes - (window.maxBytes + 1);
			if (rec.newlines > window.maxLines) {
				// `tail -n +K` keeps maxLines+1 complete lines, so a
				// line-based cut alone satisfies the skip rule.
				const keepFrom = rec.newlines - window.maxLines;
				const counted = await this.runOut(
					[
						"/bin/sh",
						"-c",
						'tail -n "+$1" "$2" | head -c "$3" | wc -c',
						"tail-bytes",
						String(keepFrom),
						rec.path,
						String(window.maxBytes + 2),
					],
					rec.path,
					context,
				);
				if (!counted.ok) {
					if (context.abortSignal?.aborted) return { kind: "aborted" };
					return {
						kind: "failed",
						message: "command output could not be measured — result not claimed complete",
					};
				}
				const tailBytes = Number(counted.value.trim());
				if (!Number.isInteger(tailBytes) || tailBytes < 1) {
					return {
						kind: "failed",
						message: "command output could not be measured — result not claimed complete",
					};
				}
				if (tailBytes <= window.maxBytes + 1) {
					start = Math.max(start, rec.bytes - tailBytes);
				}
			}
			if (start > 0) {
				// A six-byte window (the byte at the cut plus five back)
				// covers every valid character; the cut moves back at most
				// three bytes.
				const fenceFrom = Math.max(0, start - 5);
				const fence = await this.readBytesAt(
					rec.path,
					fenceFrom,
					start + 1 - fenceFrom,
					rec.path,
					context,
				);
				if (!fence.ok) {
					if (context.abortSignal?.aborted) return { kind: "aborted" };
					return {
						kind: "failed",
						message: "command output could not be read back — result not claimed complete",
					};
				}
				const probe = fence.value;
				let at = probe.length - 1;
				if ((probe[at]! & 0xc0) === 0x80) {
					while (at >= 0 && (probe[at]! & 0xc0) === 0x80) at--;
					const span = start - (fenceFrom + at);
					if (at >= 0 && span <= 3) {
						if (fenceFrom + at === 0) {
							start = 0;
						} else {
							start = fenceFrom + at;
							omittedLast = probe[at - 1]!;
						}
					}
				} else {
					omittedLast = probe[at - 1]!;
				}
			}
		}
		const length = rec.bytes - start;
		if (length > READ_CAP) {
			return {
				kind: "failed",
				message: `command output exceeds the ${READ_CAP / (1024 * 1024)} MiB delivery bound — result not claimed complete`,
			};
		}
		let skippedBytes = 0;
		if (start > 0) {
			const decoder = new TextDecoder();
			for (let offset = 0; offset < start; ) {
				if (context.abortSignal?.aborted) return { kind: "aborted" };
				const count = Math.min(SCAN_CHUNK_BYTES, start - offset);
				const chunk = await this.readBytesAt(rec.path, offset, count, rec.path, context);
				if (!chunk.ok || chunk.value.length !== count) {
					if (context.abortSignal?.aborted) return { kind: "aborted" };
					return {
						kind: "failed",
						message: "command output could not be read back — result not claimed complete",
					};
				}
				skippedBytes += Buffer.byteLength(decoder.decode(chunk.value, { stream: true }), "utf8");
				offset += count;
			}
			skippedBytes += Buffer.byteLength(decoder.decode(), "utf8");
		}
		if (context.abortSignal?.aborted) return { kind: "aborted" };
		const read = await this.readBytesAt(rec.path, start, length, rec.path, context);
		if (!read.ok || read.value.length !== length) {
			if (context.abortSignal?.aborted) return { kind: "aborted" };
			return {
				kind: "failed",
				message: "command output could not be read back — result not claimed complete",
			};
		}
		// A BOM drops only at the very start of the stream; a U+FEFF
		// after a cut (or later in the file) is text.
		const text =
			start > 0
				? new TextDecoder("utf-8", { ignoreBOM: true }).decode(read.value)
				: new TextDecoder().decode(read.value);
		if (text === "") return { kind: "ok" };
		if (start === 0) {
			onOutput(text, context, { stream });
			return { kind: "ok" };
		}
		let newlines = 0;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) newlines++;
		onOutput(text, context, {
			stream,
			skipped: {
				bytes: skippedBytes,
				newlines: rec.newlines - newlines,
				endsWithNewline: omittedLast === 0x0a,
			},
		});
		return { kind: "ok" };
	}
	// stdout first, then stderr — arrival order across separate files is
	// not recoverable; best-effort, callers decide what a failed merge means.
	private async mergeSpill(
		outPath: string,
		errPath: string,
		spillPath: string,
		context: Context,
	): Promise<{ ok: true } | { ok: false; detail: string }> {
		try {
			const r = await this.run(
				["/bin/sh", "-c", 'cat -- "$1" "$2" > "$3"', "merge-spill", outPath, errPath, spillPath],
				undefined,
				context,
			);
			if (r.timedOut) return { ok: false, detail: "merge timed out" };
			if (r.truncated) return { ok: false, detail: "merge was cut short" };
			if (r.exitCode !== 0) {
				return {
					ok: false,
					detail: `merge exited ${r.exitCode ?? "killed"}: ${r.stderr.trim().slice(0, 200)}`,
				};
			}
			return { ok: true };
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		}
	}
	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		if (context.abortSignal?.aborted) {
			return err<ShellExecResult, ExecutionError>(
				new PiExecutionError("aborted", "command aborted"),
			);
		}
		const timeoutS = Math.min(options?.timeout ?? SHELL_TIMEOUT_DEFAULT_S, SHELL_TIMEOUT_CAP_S);
		const pairs = Object.entries(options?.env ?? {});
		for (const [k] of pairs) {
			if (!ENV_NAME_RE.test(k)) {
				return err<ShellExecResult, ExecutionError>(
					new PiExecutionError("spawn_error", `invalid env name ${JSON.stringify(k)}`),
				);
			}
		}
		if (typeof command !== "string" && command.length === 0) {
			return err<ShellExecResult, ExecutionError>(
				new PiExecutionError("spawn_error", "empty argv: no program to run"),
			);
		}
		const tag = Math.random().toString(16).slice(2);
		const outPath = `/tmp/.goblin-out-${tag}`;
		const errPath = `/tmp/.goblin-err-${tag}`;
		const rcPath = `/tmp/.goblin-rc-${tag}`;
		const spillPath = `/tmp/.goblin-spill-${tag}`;
		const cwd = this.resolve(options?.cwd ?? this.cwd);
		const capBlocks = String(Math.ceil(SPILL_CAP_BYTES / 512));
		const form =
			typeof command === "string"
				? [EXEC_SH_SCRIPT, "goblin-sh", command, capBlocks]
				: [EXEC_ARGV_SCRIPT, "goblin-argv", command[0]!, capBlocks, ...command.slice(1)];
		const argv = [
			"env",
			...(options?.inheritEnv === false ? ["-i"] : []),
			...pairs.map(([k, v]) => `${k}=${v}`),
			"/bin/sh",
			"-c",
			form[0]!,
			form[1]!,
			cwd,
			outPath,
			errPath,
			rcPath,
			...form.slice(2),
		];
		try {
			const { result } = await this.sandboxes.execArgv(this.origin, argv, {
				timeoutMs: timeoutS * 1000,
				maxOutput: 4 * 1024 * 1024,
				...(context.abortSignal !== undefined ? { abortSignal: context.abortSignal } : {}),
			});
			if (result.timedOut) {
				const merged = await this.mergeSpill(outPath, errPath, spillPath, context);
				await this.guestRm(
					merged.ok ? [outPath, errPath, rcPath] : [outPath, errPath, rcPath, spillPath],
				);
				const e = new PiExecutionError(
					"timeout",
					merged.ok
						? `command timed out after ${timeoutS}s — partial output at ${spillPath}`
						: `command timed out after ${timeoutS}s`,
				);
				if (merged.ok) e.spillPath = spillPath;
				return err<ShellExecResult, ExecutionError>(e);
			}
			if (context.abortSignal?.aborted) {
				await this.guestRm([outPath, errPath, rcPath]);
				return err<ShellExecResult, ExecutionError>(
					new PiExecutionError("aborted", "command aborted"),
				);
			}
			if (result.truncated || result.exitCode !== 0) {
				await this.guestRm([outPath, errPath, rcPath]);
				return err<ShellExecResult, ExecutionError>(
					new PiExecutionError(
						"spawn_error",
						`sandbox shell failed (exit ${result.exitCode ?? "truncated"}): ${result.stderr.trim().slice(0, 500)}`,
					),
				);
			}
			return await this.finishExec(outPath, errPath, rcPath, spillPath, options, context);
		} catch (error) {
			if (context.abortSignal?.aborted === true) {
				await this.guestRm([outPath, errPath, rcPath, spillPath]);
				return err<ShellExecResult, ExecutionError>(
					new PiExecutionError("aborted", "command aborted"),
				);
			}
			throw error;
		}
	}
	private async finishExec(
		outPath: string,
		errPath: string,
		rcPath: string,
		spillPath: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const abortedExec = async (): Promise<Result<ShellExecResult, ExecutionError>> => {
			await this.guestRm([outPath, errPath, rcPath, spillPath]);
			return err<ShellExecResult, ExecutionError>(
				new PiExecutionError("aborted", "command aborted"),
			);
		};
		const failed = async (message: string): Promise<Result<ShellExecResult, ExecutionError>> => {
			await this.guestRm([outPath, errPath, rcPath, spillPath]);
			return err<ShellExecResult, ExecutionError>(new PiExecutionError("unknown", message));
		};
		const rc = await this.run(["cat", "--", rcPath], undefined, context);
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
			if (context.abortSignal?.aborted) return abortedExec();
			return failed(
				`command exit code was not recorded (rc file: ${JSON.stringify(rcText.slice(0, 60))})`,
			);
		}
		const wc = await this.run(["wc", "-l", "-c", "--", outPath, errPath], undefined, context);
		const rows = wc.stdout.trim().split("\n");
		const fields = (row: string | undefined): { lines: number; bytes: number } | null => {
			if (row === undefined) return null;
			const f = row.trim().split(/\s+/);
			if (f.length < 2) return null;
			const lines = Number(f[0]);
			const bytes = Number(f[1]);
			if (!Number.isInteger(lines) || lines < 0 || !Number.isInteger(bytes) || bytes < 0) {
				return null;
			}
			return { lines, bytes };
		};
		const outFields = fields(rows[0]);
		const errFields = fields(rows[1]);
		if (
			wc.timedOut ||
			wc.truncated ||
			wc.exitCode !== 0 ||
			outFields === null ||
			errFields === null
		) {
			if (context.abortSignal?.aborted) return abortedExec();
			return failed("command output could not be measured — result not claimed complete");
		}
		const outRec: StreamMeasure = {
			path: outPath,
			bytes: outFields.bytes,
			newlines: outFields.lines,
		};
		const errRec: StreamMeasure = {
			path: errPath,
			bytes: errFields.bytes,
			newlines: errFields.lines,
		};
		if (exitCode === 153 && (outRec.bytes >= SPILL_CAP_BYTES || errRec.bytes >= SPILL_CAP_BYTES)) {
			// 128+SIGXFSZ with an output file itself at the wall: nothing
			// is claimed. A 153 from some other file's write is just the
			// command's own exit code.
			return failed(
				`command output exceeded the ${SPILL_CAP_BYTES / (1024 * 1024)} MiB wall — killed by ulimit, output not claimed`,
			);
		}
		if (options?.onOutput !== undefined) {
			const onOutput = options.onOutput;
			const window =
				options.window === undefined
					? undefined
					: {
							maxBytes: finiteFloor(options.window.maxBytes),
							maxLines: finiteFloor(options.window.maxLines),
						};
			for (const [rec, stream] of [
				[outRec, "stdout"],
				[errRec, "stderr"],
			] as const) {
				const delivered = await this.deliverStream(rec, stream, window, onOutput, context);
				if (delivered.kind === "aborted") return abortedExec();
				if (delivered.kind === "failed") return failed(delivered.message);
			}
			if (exitCode === 153) {
				// Sent after the chunks: with a tail window, output sent
				// before later output can be dropped — the notice must not.
				onOutput(
					`[goblin] exit 153: a file write exceeded the sandbox's ${SPILL_CAP_BYTES / (1024 * 1024)} MiB per-file cap (SIGXFSZ) — produce large artifacts in chunks or stream them\n`,
					context,
					{ stream: "stderr" },
				);
			}
		}
		const spillOpt = options?.spill;
		if (
			spillOpt !== undefined &&
			(outRec.bytes + errRec.bytes > spillOpt.afterBytes ||
				outRec.newlines + errRec.newlines > spillOpt.afterLines)
		) {
			const merged = await this.mergeSpill(outPath, errPath, spillPath, context);
			if (!merged.ok) {
				if (context.abortSignal?.aborted) return abortedExec();
				return failed(
					`command output could not be preserved complete (${merged.detail}) — result not claimed`,
				);
			}
			const rm = await this.guestRm([outPath, errPath, rcPath]);
			if (rm !== null) {
				const e = new PiExecutionError(
					"unknown",
					`command output cleanup failed: ${rm} — spilled output remains at ${spillPath}`,
				);
				e.spillPath = spillPath;
				return err<ShellExecResult, ExecutionError>(e);
			}
			return ok<ShellExecResult, ExecutionError>({ exitCode, spillPath });
		}
		const rm = await this.guestRm([outPath, errPath, rcPath]);
		if (rm !== null) {
			return err<ShellExecResult, ExecutionError>(
				new PiExecutionError("unknown", `command output cleanup failed: ${rm}`),
			);
		}
		return ok<ShellExecResult, ExecutionError>({ exitCode });
	}
	async cleanup(): Promise<void> {}
}

export function makeSandboxEnv(
	sandboxes: Sandboxes,
	transferRoot: string,
	origin: string,
): ExecutionEnv {
	return new SandboxEnv(sandboxes, transferRoot, origin);
}
