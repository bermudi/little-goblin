// Bounded subprocess execution. spawnProc only fixes the stdio layout and
// can throw (caller labels the failure); boundedRun never hangs — the
// promise always settles:
//
//   timeout/abort/cap-overflow → SIGTERM → grace → SIGKILL → give up
//
// and pipe EOF gets a short grace after process exit, then the readers are
// cut: a backgrounded or orphaned child inheriting the write end must not
// outlive the command. Used by the bash tool and auth.jsonl `!command`
// resolution — a wedged child must never stall a turn or a lane.

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

// Fixed stdio for both callers: no stdin, both pipes captured, the daemon's
// environment (no secrets live there by design — auth.jsonl keeps them out).
// Throws if the process can't be spawned.
export function spawnProc(argv: string[], cwd?: string): Bun.ReadableSubprocess {
	return Bun.spawn(argv, {
		...(cwd !== undefined ? { cwd } : {}),
		env: process.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
}

// Drain a pipe to EOF, capped — a runaway process that floods a stream gets
// killed instead of buffering forever. The reader registers itself so the
// drain window after process exit can cut it off.
async function collect(
	stream: ReadableStream<Uint8Array>,
	cap: number,
	onTruncate: () => void,
	readers: Set<CancellableReader>,
): Promise<{ text: string; truncated: boolean }> {
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
	return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

// Run an already-spawned process to a settled result: combined deadline,
// abort, and cap-overflow kills funnel into TERM→KILL escalation; pipe
// readers get a short window after exit before being cut.
export async function boundedRun(
	proc: Bun.ReadableSubprocess,
	opts: { timeoutMs: number; maxOutput: number; abortSignal?: AbortSignal },
): Promise<BoundedProc> {
	const { timeoutMs, maxOutput, abortSignal } = opts;
	const readers = new Set<CancellableReader>();
	let timedOut = false;
	// The drain window cut off output still in flight — surfaced as
	// `truncated` so partial output never looks like a clean result.
	let drainCut = false;

	// TERM, then KILL after a grace period. Returns null if even KILL can't
	// reap the process — an honest null beats a hung caller.
	const killAndReap = async (): Promise<number | null> => {
		proc.kill();
		let code = await Promise.race([proc.exited, sleep(KILL_GRACE_MS)]);
		if (code === undefined) {
			proc.kill("SIGKILL");
			code = await Promise.race([proc.exited, sleep(KILL_GRACE_MS)]);
		}
		return code ?? null;
	};

	// The exit race: natural exit beats the deadline. Timeout, abort, and
	// cap-overflow kills all funnel into the escalation path.
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

	// EOF can trail process exit (kernel buffer, inherited fds): the readers
	// get a moment, then are cancelled. Readers that finished on their own
	// are already gone from the set — nothing was cut.
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
		});

	const [out, err] = await Promise.all([
		collect(proc.stdout, maxOutput, triggerKill, readers),
		collect(proc.stderr, maxOutput, triggerKill, readers),
	]);
	const exitCode = await exitP;
	return {
		stdout: out.text,
		stderr: err.text,
		exitCode,
		timedOut,
		truncated: out.truncated || err.truncated || drainCut,
	};
}
