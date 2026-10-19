import { log } from "./log.ts";

export type ProcessGroupMode = "new" | "inherit";

// Bounded subprocess execution; boundedRun's promise always settles:
// timeout/abort/cap-overflow → SIGTERM → grace → SIGKILL. Kills target
// the child's new process group by default — a timed-out `bash -c` takes
// its backgrounded grandchildren; "inherit" probes kill only the leader
// (an outer supervisor owns group cleanup). Pipe EOF gets a short grace
// after exit, then readers are cut — a backgrounded child inheriting the
// write end must not outlive the command.

const PIPE_DRAIN_MS = 250;
// If even SIGKILL can't reap it (e.g. D-state), the caller gets an
// honest null rather than a hang.
const KILL_GRACE_MS = 1_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Bun's pipe readers have cancel(), which the standard
// ReadableStreamDefaultReader type doesn't declare.
interface CancellableReader {
	cancel(reason?: unknown): Promise<void>;
}

export interface BoundedProc {
	stdout: string;
	stderr: string;
	// null when even SIGKILL couldn't reap the process.
	exitCode: number | null;
	timedOut: boolean;
	// A capped stream killed the process, or the post-exit drain window
	// cut output still in flight — incomplete either way.
	truncated: boolean;
	// The kill was a stream-cap overflow — distinct from timedOut but
	// not exclusive (the deadline can still fire mid-drain). Optional
	// so external fakes building this shape stay valid.
	outputCapped?: boolean;
	// Killed (deadline/abort/cap), not self-exited — a kill can leave
	// work running that a post-exit drain cut cannot.
	killed: boolean;
}

// stderr stays text — it's only ever an error message.
export interface BoundedProcBytes {
	stdout: Uint8Array;
	stderr: string;
	// null when even SIGKILL couldn't reap the process.
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
	outputCapped?: boolean;
	killed: boolean;
}

// env carries no secrets by design (auth.jsonl keeps them out).
// "inherit" is only for callers whose outer supervisor owns the group.
export function spawnProc(
	argv: string[],
	cwd?: string,
	stdin?: Bun.SpawnOptions.Writable,
	processGroup: ProcessGroupMode = "new",
): Bun.ReadableSubprocess {
	return Bun.spawn(argv, {
		...(cwd !== undefined ? { cwd } : {}),
		env: process.env,
		stdin: stdin ?? "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: processGroup === "new",
	});
}

// Never signal an inherited group: it includes the caller. New-group owners
// can signal their group even after leader exit, then fall back to the leader.
export function killProc(
	proc: Bun.ReadableSubprocess,
	signal: NodeJS.Signals,
	processGroup: ProcessGroupMode = "new",
): void {
	if (processGroup === "new") {
		try {
			process.kill(-proc.pid, signal);
			return;
		} catch {
			// Group gone or unaddressable — try the leader itself.
		}
	}
	try {
		proc.kill(signal);
	} catch {
		// Already reaped — the exit race below settles it.
	}
}

// Capped drain — a runaway process flooding a stream is killed rather
// than buffered forever. The reader registers so the post-exit drain
// window can cut it off.
async function collectBytes(
	stream: ReadableStream<Uint8Array>,
	cap: number,
	onTruncate: () => void,
	readers: Set<CancellableReader>,
): Promise<{ value: Uint8Array; truncated: boolean }> {
	const reader = stream.getReader();
	readers.add(reader);
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (total + value.byteLength > cap) {
				chunks.push(value.subarray(0, cap - total));
				truncated = true;
				onTruncate();
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		readers.delete(reader);
		reader.releaseLock();
	}
	return { value: Buffer.concat(chunks), truncated };
}

async function collect(
	stream: ReadableStream<Uint8Array>,
	cap: number,
	onTruncate: () => void,
	readers: Set<CancellableReader>,
): Promise<{ value: string; truncated: boolean }> {
	const { value: bytes, truncated } = await collectBytes(stream, cap, onTruncate, readers);
	return { value: Buffer.from(bytes).toString("utf8"), truncated };
}

type Collector<S> = (
	stream: ReadableStream<Uint8Array>,
	cap: number,
	onTruncate: () => void,
	readers: Set<CancellableReader>,
) => Promise<{ value: S; truncated: boolean }>;

// stderr is always text — only stdout's shape is the caller's collector.
async function runBounded<S>(
	proc: Bun.ReadableSubprocess,
	opts: {
		timeoutMs: number;
		maxOutput: number;
		abortSignal?: AbortSignal;
		processGroup?: ProcessGroupMode;
	},
	collectStdout: Collector<S>,
): Promise<{
	stdout: S;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
	outputCapped?: boolean;
	killed: boolean;
}> {
	const { timeoutMs, maxOutput, abortSignal } = opts;
	const readers = new Set<CancellableReader>();
	let timedOut = false;
	let drainCut = false;
	let outputCapped = false;
	let killed = false;

	const killAndReap = async (): Promise<number | null> => {
		killProc(proc, "SIGTERM", opts.processGroup);
		let code = await Promise.race([proc.exited, sleep(KILL_GRACE_MS)]);
		if (code === undefined) {
			killProc(proc, "SIGKILL", opts.processGroup);
			code = await Promise.race([proc.exited, sleep(KILL_GRACE_MS)]);
		}
		return code ?? null;
	};

	let stopDeadline!: () => void;
	const deadline = new Promise<"timeout">((res) => {
		const t = setTimeout(() => res("timeout"), timeoutMs);
		stopDeadline = () => clearTimeout(t);
	});
	let triggerKill!: () => void;
	const killP = new Promise<"killed">((res) => {
		triggerKill = () => res("killed");
	});
	const onAbort = () => triggerKill();
	if (abortSignal?.aborted) triggerKill();
	else abortSignal?.addEventListener("abort", onAbort, { once: true });

	const exitP: Promise<number | null> = (async () => {
		const first = await Promise.race([proc.exited, deadline, killP]);
		stopDeadline();
		abortSignal?.removeEventListener("abort", onAbort);
		if (typeof first === "number") return first;
		killed = true;
		if (first === "timeout") timedOut = true;
		return killAndReap();
	})();

	void exitP
		.then(() => sleep(PIPE_DRAIN_MS))
		.then(() => {
			if (readers.size === 0) return;
			drainCut = true;
			for (const r of readers) {
				try {
					void r.cancel().catch((err: unknown) => {
						log.warn("process pipe cancel failed", err, {});
					});
				} catch (err) {
					log.debug("process pipe cancel failed — reader may be released", { error: String(err) });
				}
			}
		})
		.catch((err: unknown) => {
			log.warn("process pipe drain failed", err, {});
		});

	// The collectors' truncate callback is the cap witness — a
	// post-exit drain cutoff never reaches it.
	const onOutputCap = () => {
		outputCapped = true;
		triggerKill();
	};
	const [out, err] = await Promise.all([
		collectStdout(proc.stdout, maxOutput, onOutputCap, readers),
		collect(proc.stderr, maxOutput, onOutputCap, readers),
	]);
	const exitCode = await exitP;
	return {
		stdout: out.value,
		stderr: err.value,
		exitCode,
		timedOut,
		truncated: out.truncated || err.truncated || drainCut,
		outputCapped,
		killed,
	};
}

export async function boundedRun(
	proc: Bun.ReadableSubprocess,
	opts: {
		timeoutMs: number;
		maxOutput: number;
		abortSignal?: AbortSignal;
		processGroup?: ProcessGroupMode;
	},
): Promise<BoundedProc> {
	return runBounded(proc, opts, collect);
}

export async function boundedRunBinary(
	proc: Bun.ReadableSubprocess,
	opts: {
		timeoutMs: number;
		maxOutput: number;
		abortSignal?: AbortSignal;
		processGroup?: ProcessGroupMode;
	},
): Promise<BoundedProcBytes> {
	return runBounded(proc, opts, collectBytes);
}
