// The sandbox env's shell wall and reader/exec contract against the
// in-memory guest fs (fakeSandboxes): spill/prefix/argv/timeout
// semantics trained on every `bun test`. podman.test.ts runs the same
// contracts through real containers when gated.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { OutputBuffer } from "@earendil-works/chord/output";
import { setLogFile } from "../log.ts";
import { makeSandboxEnv } from "./env.ts";
import { dirs, fakeSandboxes, type MemSandbox } from "./testing.ts";

setLogFile(null);

// ---------- the worker shell wall (SandboxEnv.exec) ----------

// Stages the wrapped-shell outcome directly: the `env` call writes the
// given rc + stdout into the guest fs instead of evaluating a script,
// so the SIGXFSZ exit can be pinned without a 100 MiB stdout.
function stageShellExit(sb: MemSandbox, rc: number, spillText: string | Uint8Array): void {
	const enc = new TextEncoder();
	const real = sb.execArgv;
	sb.execArgv = async (conv, argv, opts) => {
		if (argv[0] === "env") {
			const rest = argv.slice(1);
			const shIdx = rest.indexOf("/bin/sh");
			const outPath = rest[shIdx + 5] ?? "/tmp/x";
			const errPath = rest[shIdx + 6] ?? "/tmp/y";
			const rcPath = rest[shIdx + 7] ?? "/tmp/z";
			sb.fs.write(
				sb.fs.norm(outPath),
				typeof spillText === "string" ? enc.encode(spillText) : spillText,
			);
			sb.fs.write(sb.fs.norm(errPath), enc.encode(""));
			sb.fs.write(sb.fs.norm(rcPath), enc.encode(String(rc)));
			return {
				result: {
					stdout: "",
					stderr: "",
					exitCode: 0,
					timedOut: false,
					killed: false,
					truncated: false,
				},
			};
		}
		return real(conv, argv, opts);
	};
}

describe("worker shell wall", () => {
	const CTX = {} as Context; // no abortSignal, no scope

	test.each(["waiting", "copied"] as const)(
		"a worker write cancelled while %s forwards cancellation and removes both stages",
		async (when) => {
			const sb = fakeSandboxes();
			const root = mkdtempSync(join(tmpdir(), "goblin-stage-abort-"));
			dirs.push(root);
			const env = makeSandboxEnv(sb, root, "conv:cancelled-write");
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const ctl = new AbortController();
			const cpIn = sb.cpIn.bind(sb);
			let guest = "";
			sb.cpIn = async (conv, host, dest, opts) => {
				expect(opts?.abortSignal).toBe(ctl.signal);
				guest = dest;
				entered.resolve();
				await gate.promise;
				if (when === "waiting") opts?.abortSignal?.throwIfAborted();
				return cpIn(conv, host, dest);
			};
			const pending = env.writeFile("/work/out.txt", "cancelled full content", {
				abortSignal: ctl.signal,
			} as Context);
			await entered.promise;
			ctl.abort();
			gate.resolve();
			const result = await pending;
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("aborted");
			expect(sb.fs.exists(guest)).toBe(false);
			expect(sb.fs.exists("/work/out.txt")).toBe(false);
			expect(readdirSync(root)).toEqual([]);
		},
	);

	test("filesystem classifications use controlled probes, not text in hostile filenames", async () => {
		const root = mkdtempSync(join(tmpdir(), "goblin-fs-errors-"));
		dirs.push(root);
		const dir = join(root, "no such directory");
		const file = join(root, "Permission denied");
		mkdirSync(dir);
		writeFileSync(file, "regular");
		const sb = fakeSandboxes();
		const run = async (argv: string[]) => {
			const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, exitCode, timedOut: false, truncated: false, killed: false };
		};
		sb.execArgv = async (_conv, argv) => ({ result: await run(argv) });
		sb.execBytesArgv = async (_conv, argv) => {
			const result = await run(argv);
			return { result: { ...result, stdout: new TextEncoder().encode(result.stdout) } };
		};
		const env = makeSandboxEnv(sb, root, "conv:filesystem-status");
		for (const [result, code] of [
			[await env.readBinaryFile(dir, CTX), "is_directory"],
			[await env.fileInfo(join(root, "Is a directory missing"), CTX), "not_found"],
			[await env.readBinaryFile(join(file, "no such file"), CTX), "not_directory"],
			[await env.listDir(file, CTX), "not_directory"],
		] as const) {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe(code);
		}
	});

	test("exit 153 below the spill cap explains the file-size kill and returns the real exit code", async () => {
		const sb = fakeSandboxes();
		stageShellExit(sb, 153, "partial output\n");
		const env = makeSandboxEnv(sb, join(tmpdir(), "goblin-wall-under"), "conv:wall");
		let streamed = "";
		const r = await env.exec(
			"curl -o /work/big.bin https://example.com/huge",
			{ onOutput: (s) => (streamed += s) },
			CTX,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.exitCode).toBe(153);
		expect(streamed).toContain("exit 153");
		expect(streamed).toContain("100 MiB per-file cap");
		expect(streamed).toContain("chunks or stream");
		// The command's own output still rides back under the note.
		expect(streamed).toContain("partial output");
	});

	test("a spill that reached the cap still refuses with the wall error", async () => {
		const sb = fakeSandboxes();
		stageShellExit(sb, 153, "x".repeat(100 * 1024 * 1024));
		const env = makeSandboxEnv(sb, join(tmpdir(), "goblin-wall-cap"), "conv:wall");
		const r = await env.exec("seq 100000000", undefined, CTX);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.message).toContain("MiB wall");
	});

	// The temp files behind a shell exec (spill + rc) are cleanup the
	// operation owns: when the guest rm fails, a successful command is
	// still a failure — success must never be claimed over a leaked
	// or unverified cleanup.
	test("a failed guest temp cleanup turns a successful shell exec into an error", async () => {
		const sb = fakeSandboxes();
		const real = sb.execArgv;
		sb.execArgv = async (conv, argv, opts) => {
			if (argv[0] === "rm") {
				return {
					result: {
						stdout: "",
						stderr: "rm: simulated cleanup failure",
						exitCode: 1,
						timedOut: false,
						killed: false,
						truncated: false,
					},
				};
			}
			return real(conv, argv, opts);
		};
		const env = makeSandboxEnv(sb, join(tmpdir(), "goblin-rm-exec"), "conv:rm");
		const r = await env.exec("echo hi", undefined, CTX);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.code).toBe("unknown");
		expect(r.error.message).toContain("cleanup");
	});

	// The symmetric boundary: when the command itself already failed,
	// its error is the operation's — the cleanup failure rides only
	// in the log, never replacing the primary failure.
	test("a failed guest temp cleanup never masks the primary exec error", async () => {
		const sb = fakeSandboxes();
		const real = sb.execArgv;
		sb.execArgv = async (conv, argv, opts) => {
			if (argv[0] === "rm") {
				return {
					result: {
						stdout: "",
						stderr: "rm dead",
						exitCode: 1,
						timedOut: false,
						killed: false,
						truncated: false,
					},
				};
			}
			return real(conv, argv, opts);
		};
		const env = makeSandboxEnv(sb, join(tmpdir(), "goblin-rm-primary"), "conv:rm");
		const r = await env.exec("echo hi", { cwd: "/no/such/dir" }, CTX);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.message).toContain("sandbox shell failed");
		expect(r.error.message).not.toContain("cleanup");
	});

	// The same contract at the staged-write boundary, with a thrown
	// rm (the sandbox exec dying) rather than a nonzero exit: a
	// successful staged write reports its cleanup failure, while a
	// write that already failed keeps its own error.
	test("a thrown guest staging cleanup fails a successful write; a failed write keeps its own error", async () => {
		const sb = fakeSandboxes();
		const real = sb.execArgv;
		sb.execArgv = async (conv, argv, opts) => {
			if (argv[0] === "rm") throw new Error("podman exec died");
			return real(conv, argv, opts);
		};
		const root = mkdtempSync(join(tmpdir(), "goblin-rm-stage-"));
		dirs.push(root);
		const env = makeSandboxEnv(sb, root, "conv:rm-stage");
		const staged = await env.writeFile("/work/out.txt", "data", CTX);
		expect(staged.ok).toBe(false);
		if (staged.ok) return;
		expect(staged.error.message).toContain("cleanup");
		// The write itself landed — only the stage cleanup failed.
		expect(sb.fs.exists("/work/out.txt")).toBe(true);
		// A write that failed on its own keeps that error — the
		// cleanup failure stays a log line, never the reported cause.
		sb.fs.write("/work/blocker", new TextEncoder().encode("x"));
		const blocked = await env.writeFile("/work/blocker/x.txt", "data", CTX);
		expect(blocked.ok).toBe(false);
		if (blocked.ok) return;
		expect(blocked.error.code).toBe("not_directory");
		expect(blocked.error.message).not.toContain("cleanup");
	});
});

// ---------- the sandbox env's reader/exec contract (fake guest fs) ----------

// The live gate runs the same contract through the upstream
// `registerEnvConformance` against real podman execs; these cases keep
// the boundary exercised on every `bun test` with the in-memory guest.
describe("sandbox env contract (fake guest fs)", () => {
	const CTX = {} as Context; // no abortSignal, no scope
	const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
		if (!r.ok) throw new Error(r.error.message);
		return r.value;
	};
	const tmpLeftovers = (sb: MemSandbox): string[] =>
		sb.fs.children("/tmp").filter((p) => p.startsWith("/tmp/.goblin-"));
	const newEnv = (tag: string) => {
		const sb = fakeSandboxes();
		const root = mkdtempSync(join(tmpdir(), `goblin-env-${tag}-`));
		dirs.push(root);
		return { sb, env: makeSandboxEnv(sb, root, `conv:${tag}`) };
	};
	const failureCode = async (
		r: Promise<{ ok: boolean; error?: { code: string } }>,
	): Promise<string> => {
		const result = await r;
		expect(result.ok).toBe(false);
		return result.error?.code ?? "missing";
	};

	test("binary reader reads ranges, keeps the opened file across a rename, and refuses after close", async () => {
		const { sb, env } = newEnv("br");
		must(await env.writeFile("/work/data.txt", "hello\nworld\n", CTX));
		const reader = must(await env.openBinaryReader("/work/data.txt", undefined, CTX));
		const dec = new TextDecoder();
		expect(dec.decode(must(await reader.read(0, 5, CTX)))).toBe("hello");
		expect(dec.decode(must(await reader.read(6, 100, CTX)))).toBe("world\n");
		expect(must(await reader.read(12, 4, CTX)).length).toBe(0);
		expect(must(await reader.read(50, 1, CTX)).length).toBe(0);
		expect(must(await reader.read(3, 0, CTX)).length).toBe(0);
		expect(must(await reader.info(CTX))).toMatchObject({
			name: "data.txt",
			kind: "file",
			size: 12,
		});
		// scanLines walks the same pinned file — the selected range reads
		// back as the second line plus its newline.
		const scan = must(await reader.scanLines({ startLine: 1 }, CTX));
		expect(scan.newlines).toBe(2);
		expect(dec.decode(must(await reader.read(scan.start, scan.end - scan.start, CTX)))).toBe(
			"world\n",
		);
		expect(await failureCode(reader.read(-1, 1, CTX))).toBe("invalid");
		expect(await failureCode(reader.read(0, 1.5, CTX))).toBe("invalid");
		// The abort check precedes closed/arg checks — an aborted context
		// wins over an otherwise-valid call.
		expect(
			await failureCode(reader.read(0, 1, { abortSignal: AbortSignal.abort() } as Context)),
		).toBe("aborted");
		// The reader keeps the opened file: the path is renamed and
		// rewritten, the pin still serves the original bytes.
		must(await env.renameFile("/work/data.txt", "/work/moved.txt", CTX));
		must(await env.writeFile("/work/data.txt", "two", CTX));
		expect(dec.decode(must(await reader.read(0, 12, CTX)))).toBe("hello\nworld\n");
		await reader.close(CTX);
		await reader.close(CTX);
		expect(await failureCode(reader.read(0, 1, CTX))).toBe("invalid");
		expect(await failureCode(reader.info(CTX))).toBe("invalid");
		// No hidden pin survives the close.
		expect(
			sb.fs.children("/work").filter((p) => posix.basename(p).startsWith(".goblin-br-")),
		).toEqual([]);
		// Open classifications: a directory and a missing path are refused
		// before any reader exists.
		expect(await failureCode(env.openBinaryReader("/work", undefined, CTX))).toBe("is_directory");
		expect(await failureCode(env.openBinaryReader("/work/nope.txt", undefined, CTX))).toBe(
			"not_found",
		);
	});

	test("directory reader pages entries once, skips the vanished, and refuses use after close", async () => {
		const { env } = newEnv("dir");
		for (const n of ["a", "b", "c", "d", "e"]) {
			must(await env.writeFile(`/work/d/${n}.txt`, n, CTX));
		}
		const reader = must(await env.openDirReader("/work/d", CTX));
		const first = must(await reader.next(2, CTX));
		expect(first.done).toBe(false);
		expect(first.entries.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
		expect(first.entries[0]).toMatchObject({ kind: "file", size: 1 });
		// c and d vanish after the listing: their page reports no entries
		// but still advances, and the final page hands over e and claims
		// done — repeating later without another stat pass.
		must(await env.remove("/work/d/c.txt", undefined, CTX));
		must(await env.remove("/work/d/d.txt", undefined, CTX));
		expect(must(await reader.next(2, CTX))).toEqual({ entries: [], done: false });
		const last = must(await reader.next(2, CTX));
		expect(last.entries.map((e) => e.name)).toEqual(["e.txt"]);
		expect(last.done).toBe(true);
		expect(must(await reader.next(2, CTX))).toEqual({ entries: [], done: true });
		// The abort check precedes the page-size and done short-circuits:
		// an aborted context wins even on a done reader.
		expect(await failureCode(reader.next(1, { abortSignal: AbortSignal.abort() } as Context))).toBe(
			"aborted",
		);
		expect(await failureCode(reader.next(0, CTX))).toBe("invalid");
		await reader.close(CTX);
		await reader.close(CTX);
		expect(await failureCode(reader.next(1, CTX))).toBe("invalid");
	});

	test("windowed exec delivers the exact tail and counts every skipped byte and line", async () => {
		const { env } = newEnv("window");
		const chunks: {
			text: string;
			stream: "stdout" | "stderr";
			skipped?: { bytes: number; newlines: number; endsWithNewline: boolean };
		}[] = [];
		const r = await env.exec(
			"seq 1 200",
			{
				window: { maxBytes: 20, maxLines: 3, minIntervalMs: 0, bytesPerSecond: 1_000_000_000 },
				onOutput: (text, _ctx, info) => {
					chunks.push({
						text,
						stream: info.stream,
						...(info.skipped === undefined ? {} : { skipped: info.skipped }),
					});
				},
			},
			CTX,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.exitCode).toBe(0);
		expect(chunks.length).toBe(1);
		const c = chunks[0]!;
		expect(c.stream).toBe("stdout");
		expect(c.text).toBe("197\n198\n199\n200\n");
		const skipped = c.skipped;
		expect(skipped).toBeDefined();
		if (skipped === undefined) return;
		expect(skipped).toEqual({ bytes: 676, newlines: 196, endsWithNewline: true });
		// skip + delivered reconstruct the full 692-byte, 200-newline stream.
		const enc = new TextEncoder();
		expect(skipped.bytes + enc.encode(c.text).length).toBe(692);
		expect(skipped.newlines + c.text.split("\n").length - 1).toBe(200);
		// The skip rule: a chunk after a skip exceeds the window.
		expect(enc.encode(c.text).length > 20 || c.text.split("\n").length - 1 > 3).toBe(true);
		expect(c.text.endsWith("198\n199\n200\n")).toBe(true);
	});

	test("windowed exec counts replacement characters throughout the omitted prefix", async () => {
		const { sb, env } = newEnv("invalid-prefix");
		const bytes = new Uint8Array(10_064).fill(0xff);
		bytes.fill(0x61, 10_000);
		stageShellExit(sb, 0, bytes);
		const output = new OutputBuffer({ retain: "tail", maxBytes: 32, maxLines: 100 });
		let skippedBytes = 0;
		let deliveredBytes = 0;
		const result = await env.exec(
			"binary output",
			{
				window: { maxBytes: 32, maxLines: 100, minIntervalMs: 0, bytesPerSecond: 1_000_000_000 },
				onOutput: (text, _ctx, info) => {
					expect(info.skipped).toEqual({ bytes: 30_031, newlines: 0, endsWithNewline: false });
					skippedBytes += info.skipped?.bytes ?? 0;
					deliveredBytes += new TextEncoder().encode(text).length;
					output.push(text, info.skipped);
				},
			},
			CTX,
		);
		must(result);
		output.end();
		expect(skippedBytes).toBe(30_031);
		expect(deliveredBytes).toBe(33);
		expect(skippedBytes + deliveredBytes).toBe(30_064);
		expect(output.snapshot()).toEqual({
			text: "a".repeat(32),
			droppedBytes: 30_032,
			droppedLines: 0,
		});
	});

	test("omitted-prefix decoding preserves state across bounded reads and handles BOMs and incomplete UTF-8", async () => {
		const { sb, env } = newEnv("prefix-chunks");
		const chunkBytes = 8 * 1024 * 1024;
		const bytes = new Uint8Array(chunkBytes + 128).fill(0x61);
		const cut = bytes.length - 33;
		bytes.set([0xef, 0xbb, 0xbf], 0); // Only this initial BOM is dropped.
		bytes.set([0xe2, 0x82, 0xac], chunkBytes - 1); // Split a valid character across reads.
		bytes.set([0xef, 0xbb, 0xbf], chunkBytes + 12);
		bytes.set([0xff, 0xff], 100);
		bytes.set([0xe2, 0x82], cut - 2); // The omitted prefix ends with an incomplete character.
		stageShellExit(sb, 0, bytes);
		const reads: number[] = [];
		const real = sb.execBytesArgv;
		sb.execBytesArgv = async (conv, argv, opts) => {
			const count = Number(argv.find((a) => a.startsWith("count="))?.slice(6));
			if (argv[0] === "dd" && count > 33) reads.push(count);
			return real(conv, argv, opts);
		};
		const enc = new TextEncoder();
		const totalBytes = enc.encode(new TextDecoder().decode(bytes)).length;
		const expectedSkipped = enc.encode(new TextDecoder().decode(bytes.subarray(0, cut))).length;
		const output = new OutputBuffer({ retain: "tail", maxBytes: 32, maxLines: 100 });
		let measuredBytes = 0;
		must(
			await env.exec(
				"binary output",
				{
					window: { maxBytes: 32, maxLines: 100, minIntervalMs: 0, bytesPerSecond: 1_000_000_000 },
					onOutput: (text, _ctx, info) => {
						expect(info.skipped?.bytes).toBe(expectedSkipped);
						measuredBytes += (info.skipped?.bytes ?? 0) + enc.encode(text).length;
						output.push(text, info.skipped);
					},
				},
				CTX,
			),
		);
		output.end();
		expect(reads).toEqual([chunkBytes, cut - chunkBytes]);
		expect(measuredBytes).toBe(totalBytes);
		expect(output.snapshot()).toEqual({
			text: "a".repeat(32),
			droppedBytes: totalBytes - 32,
			droppedLines: 0,
		});
	});

	test.each(["short", "aborted"] as const)(
		"omitted-prefix scan refuses %s reads without delivering output",
		async (failure) => {
			const { sb, env } = newEnv(`prefix-${failure}`);
			stageShellExit(sb, 0, new Uint8Array(10_064).fill(0xff));
			const ctl = new AbortController();
			const real = sb.execBytesArgv;
			let scans = 0;
			sb.execBytesArgv = async (conv, argv, opts) => {
				const result = await real(conv, argv, opts);
				if (argv[0] === "dd" && argv.includes("skip=0")) {
					scans++;
					if (failure === "aborted") {
						expect(opts?.abortSignal).toBe(ctl.signal);
						ctl.abort();
					} else {
						result.result.stdout = result.result.stdout.subarray(1);
					}
				}
				return result;
			};
			let deliveries = 0;
			const result = await env.exec(
				"binary output",
				{
					window: { maxBytes: 32, maxLines: 100, minIntervalMs: 0, bytesPerSecond: 1_000_000_000 },
					onOutput: () => {
						deliveries++;
					},
				},
				{ abortSignal: ctl.signal } as Context,
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.code).toBe(failure === "aborted" ? "aborted" : "unknown");
				if (failure === "short") expect(result.error.message).toContain("could not be read back");
			}
			expect(scans).toBe(1);
			expect(deliveries).toBe(0);
			expect(tmpLeftovers(sb)).toEqual([]);
		},
	);

	test("a spill over the threshold merges into a readable file with no temp files left behind", async () => {
		const { sb, env } = newEnv("spill");
		const r = await env.exec("seq 1 100", { spill: { afterBytes: 10, afterLines: 0 } }, CTX);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.exitCode).toBe(0);
		const spill = r.value.spillPath;
		expect(spill).toBeDefined();
		expect(new TextDecoder().decode(sb.fs.read(sb.fs.norm(spill!)))).toBe(
			Array.from({ length: 100 }, (_, i) => `${i + 1}\n`).join(""),
		);
		// The measured files and the rc are gone; only the advertised
		// spill remains.
		expect(tmpLeftovers(sb)).toEqual([spill!]);
	});

	test("argv exec hands the program its arguments unparsed", async () => {
		const { sb, env } = newEnv("argv");
		const captured: string[][] = [];
		const real = sb.execArgv;
		sb.execArgv = async (conv, argv, opts) => {
			captured.push([...argv]);
			return real(conv, argv, opts);
		};
		const hostile = "it's $(touch pwned) `touch pwned` *; touch pwned";
		let out = "";
		const r = await env.exec(
			["echo", hostile, "a b"],
			{
				onOutput: (text, _ctx, info) => {
					if (info.stream === "stdout") out += text;
				},
			},
			CTX,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.exitCode).toBe(0);
		expect(out).toBe(`${hostile} a b\n`);
		const call = captured.find((a) => a.includes("goblin-argv"));
		expect(call).toBeDefined();
		if (call === undefined) return;
		// The wrapper layout is tag/cwd/out/err/rc/program/cap/args…: the
		// hostile text and the spaced argument each ride as ONE argv
		// element after the cap — never re-joined or shell-quoted.
		const i = call.indexOf("goblin-argv");
		expect(call[i + 5]).toBe("echo");
		const args = call.slice(i + 6);
		expect(args.filter((a) => a === hostile).length).toBe(1);
		expect(args.filter((a) => a === "a b").length).toBe(1);
		expect(sb.fs.exists("/work/pwned")).toBe(false);
	});

	test("a missing program and an empty argv are spawn errors; empty argv never reaches the sandbox", async () => {
		const { sb, env } = newEnv("argv-missing");
		const missing = await env.exec(["pi-durable-conformance-missing-program"], undefined, CTX);
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.error.code).toBe("spawn_error");
			expect(missing.error.message).toContain("program not found");
		}
		const calls = sb.execCalls;
		expect(calls).toBeGreaterThan(0);
		const empty = await env.exec([], undefined, CTX);
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.error.code).toBe("spawn_error");
		expect(sb.execCalls).toBe(calls);
	});

	test("a timed-out command advertises a readable spill and leaves no temp files", async () => {
		const { sb, env } = newEnv("timeout");
		const enc = new TextEncoder();
		const real = sb.execArgv;
		sb.execArgv = async (conv, argv, opts) => {
			if (argv[0] === "env" && argv.includes("goblin-sh")) {
				// The kill left both stream files behind with partial output;
				// the rc was never written.
				const rest = argv.slice(1);
				const shIdx = rest.indexOf("/bin/sh");
				sb.fs.write(sb.fs.norm(rest[shIdx + 5] ?? ""), enc.encode("partial-out\n"));
				sb.fs.write(sb.fs.norm(rest[shIdx + 6] ?? ""), enc.encode("partial-err\n"));
				return {
					result: {
						stdout: "",
						stderr: "",
						exitCode: null,
						timedOut: true,
						killed: true,
						truncated: false,
					},
				};
			}
			return real(conv, argv, opts);
		};
		const r = await env.exec("sleep 30; echo late", { timeout: 1 }, CTX);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.code).toBe("timeout");
		expect(r.error.message).toContain("timed out after 1s");
		const spill = r.error.spillPath;
		expect(spill).toBeDefined();
		expect(new TextDecoder().decode(sb.fs.read(sb.fs.norm(spill!)))).toBe(
			"partial-out\npartial-err\n",
		);
		expect(tmpLeftovers(sb)).toEqual([spill!]);
	});

	test("a failed spill merge refuses the result and advertises no spill path", async () => {
		const { sb, env } = newEnv("merge-fail");
		const real = sb.execArgv;
		sb.execArgv = async (conv, argv, opts) => {
			if (argv[0] === "/bin/sh" && argv[3] === "merge-spill") {
				return {
					result: {
						stdout: "",
						stderr: "merge dead",
						exitCode: 1,
						timedOut: false,
						killed: false,
						truncated: false,
					},
				};
			}
			return real(conv, argv, opts);
		};
		const r = await env.exec("seq 1 100", { spill: { afterBytes: 10, afterLines: 0 } }, CTX);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.code).toBe("unknown");
		expect(r.error.message).toContain("could not be preserved complete");
		expect(r.error.message).toContain("merge dead");
		expect(r.error.spillPath).toBeUndefined();
		expect(tmpLeftovers(sb)).toEqual([]);
	});
});
