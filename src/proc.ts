// Bounded subprocess execution. spawnProc only fixes the stdio layout and
// can throw (caller labels the failure); boundedRun never hangs — the
// promise always settles:
//
//   timeout/abort/cap-overflow → SIGTERM → grace → SIGKILL → give up
//
// Kills target the whole process group (the child is spawned detached, so
// it leads its own group): a timed-out `bash -c` takes its backgrounded
// grandchildren with it instead of leaving them running on the box.
//
// and pipe EOF gets a short grace after process exit, then the readers are
// cut: a backgrounded or orphaned child inheriting the write end must not
// outlive the command. Used by the bash tool, TTS remux, and auth.jsonl
// `!command` resolution — a wedged child must never stall a turn or a lane.

const PIPE_DRAIN_MS = 250;
// SIGTERM gets a grace period, then SIGKILL. If even KILL can't reap it
// (e.g. D-state), the caller gets an honest null rather than a hang.
const KILL_GRACE_MS = 1_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Bun's pipe readers carry extra methods the standard
// ReadableStreamDefaultReader type doesn't declare — all the drain cutoff
// needs is cancel().
interface CancellableReader {
	cancel(reason?: unknown): Promise<void>;
}

export interface BoundedProc {
	stdout: string;
	stderr: string;
	// null when even SIGKILL couldn't reap the process.
	exitCode: number | null;
	timedOut: boolean;
	// A capped stream killed the process, or the post-exit drain window cut
	// output still in flight — the output is incomplete either way.
	truncated: boolean;
}

// Binary variant for callers whose stdout isn't text (TTS remux returns
// ogg/opus bytes). stderr stays text — it's only ever an error message.
export interface BoundedProcBytes {
	stdout: Uint8Array;
	stderr: string;
	// null when even SIGKILL couldn't reap the process.
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
}

// Fixed stdio for callers: both pipes captured, the daemon's environment
// (no secrets live there by design — auth.jsonl keeps them out). Detached
// so the child leads its own process group — group kills below reach
// grandchildren. Throws if the process can't be spawned.
export function spawnProc(
	argv: string[],
	cwd?: string,
	stdin?: Bun.SpawnOptions.Writable,
): Bun.ReadableSubprocess {
	return Bun.spawn(argv, {
		...(cwd !== undefined ? { cwd } : {}),
		env: process.env,
		stdin: stdin ?? "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
}

// Signal the whole process group; fall back to the leader-only kill when
// the group is already gone (ESRCH) or the platform refuses it.
function killGroup(proc: Bun.ReadableSubprocess, signal: NodeJS.Signals): void {
	try {
		process.kill(-proc.pid, signal);
		return;
	} catch {
		// Group gone or unaddressable — try the leader itself.
	}
	try {
		proc.kill(signal);
	} catch {
		// Already reaped — the exit race below settles it.
	}
}

// Drain a pipe to EOF, capped — a runaway process that floods a stream gets
// killed instead of buffering forever. The reader registers itself so the
// drain window after process exit can cut it off.
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

// The one runner: combined deadline, abort, and cap-overflow kills funnel
// into group TERM→KILL escalation; pipe readers get a short window after
// exit before being cut. stdout's shape (text vs bytes) is the caller's
// collector; stderr is always text — it's only ever an error message.
async function runBounded<S>(
	proc: Bun.ReadableSubprocess,
	opts: { timeoutMs: number; maxOutput: number; abortSignal?: AbortSignal },
	collectStdout: Collector<S>,
): Promise<{
	stdout: S;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
}> {
	const { timeoutMs, maxOutput, abortSignal } = opts;
	const readers = new Set<CancellableReader>();
	let timedOut = false;
	let drainCut = false;

	const killAndReap = async (): Promise<number | null> => {
		killGroup(proc, "SIGTERM");
		let code = await Promise.race([proc.exited, sleep(KILL_GRACE_MS)]);
		if (code === undefined) {
			killGroup(proc, "SIGKILL");
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
	const killed = new Promise<"killed">((res) => {
		triggerKill = () => res("killed");
	});
	const onAbort = () => triggerKill();
	if (abortSignal?.aborted) triggerKill();
	else abortSignal?.addEventListener("abort", onAbort, { once: true });

	const exitP: Promise<number | null> = (async () => {
		const first = await Promise.race([proc.exited, deadline, killed]);
		stopDeadline();
		abortSignal?.removeEventListener("abort", onAbort);
		if (typeof first === "number") return first;
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
					void r.cancel().catch(() => {});
				} catch {
					// released mid-iteration — nothing to cancel
				}
			}
		})
		.catch(() => {});

	const [out, err] = await Promise.all([
		collectStdout(proc.stdout, maxOutput, triggerKill, readers),
		collect(proc.stderr, maxOutput, triggerKill, readers),
	]);
	const exitCode = await exitP;
	return {
		stdout: out.value,
		stderr: err.value,
		exitCode,
		timedOut,
		truncated: out.truncated || err.truncated || drainCut,
	};
}

// Run an already-spawned process to a settled result — text stdout.
export async function boundedRun(
	proc: Bun.ReadableSubprocess,
	opts: { timeoutMs: number; maxOutput: number; abortSignal?: AbortSignal },
): Promise<BoundedProc> {
	return runBounded(proc, opts, collect);
}

// Binary-stdout twin for callers whose stdout isn't text (TTS ffmpeg
// remux). Same deadline/abort/cap/group-kill contract, same
// bounded-settles guarantee — one runner, different collector.
export async function boundedRunBinary(
	proc: Bun.ReadableSubprocess,
	opts: { timeoutMs: number; maxOutput: number; abortSignal?: AbortSignal },
): Promise<BoundedProcBytes> {
	return runBounded(proc, opts, collectBytes);
}
