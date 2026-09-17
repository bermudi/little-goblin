import { tool } from "ai";
import { z } from "zod";

const MAX_OUTPUT = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
// After the process exits, the pipes get a short window to flush — then
// the readers are cut. A backgrounded or orphaned child inherits the
// write end and can hold EOF open indefinitely; EOF must not outlive
// the command itself, or a "sleep 3600 &" wedges the tool forever.
const PIPE_DRAIN_MS = 250;
// SIGTERM gets a grace period, then SIGKILL. If even KILL can't reap it
// (e.g. D-state), the tool returns rather than hanging the turn.
const KILL_GRACE_MS = 1_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Bun's pipe readers carry extra methods the standard
// ReadableStreamDefaultReader type doesn't declare — all the drain
// cutoff needs is cancel().
interface CancellableReader {
	cancel(reason?: unknown): Promise<void>;
}

// Drain a pipe to EOF, capped — a runaway command that floods a stream
// gets killed instead of buffering forever. The reader registers itself
// so the drain window after process exit can cut it off.
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

export const bashTool = (cwd: string) =>
	tool({
		description:
			"Run a shell command in the conversation's working directory. Returns combined stdout/stderr and the exit code.",
		inputSchema: z.object({
			command: z.string(),
			timeout_ms: z.number().int().positive().optional(),
		}),
		execute: async ({ command, timeout_ms }, { abortSignal }) => {
			const timeout = Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
			let proc: Bun.ReadableSubprocess;
			try {
				proc = Bun.spawn(["/bin/bash", "-c", command], {
					cwd,
					env: process.env,
					stdout: "pipe",
					stderr: "pipe",
				});
			} catch (err) {
				return { error: `spawn failed: ${(err as Error).message}` };
			}

			const readers = new Set<CancellableReader>();
			let timedOut = false;
			// The drain window cut off output still in flight — surfaced as
			// `truncated` so partial output never looks like a clean result.
			let drainCut = false;

			// TERM, then KILL after a grace period. Returns null if even KILL
			// can't reap the process — an honest null beats a hung turn.
			const killAndReap = async (): Promise<number | null> => {
				proc.kill();
				let code = await Promise.race([proc.exited, sleep(KILL_GRACE_MS)]);
				if (code === undefined) {
					proc.kill("SIGKILL");
					code = await Promise.race([proc.exited, sleep(KILL_GRACE_MS)]);
				}
				return code ?? null;
			};

			// The exit race: natural exit beats the deadline. Timeout, abort,
			// and cap-overflow kills all funnel into the escalation path.
			let stopDeadline!: () => void;
			const deadline = new Promise<"timeout">((res) => {
				const t = setTimeout(() => res("timeout"), timeout);
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

			// EOF can trail process exit (kernel buffer, inherited fds): the
			// readers get a moment, then are cancelled. Readers that finished
			// on their own are already gone from the set — nothing was cut.
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
				collect(proc.stdout, MAX_OUTPUT, triggerKill, readers),
				collect(proc.stderr, MAX_OUTPUT, triggerKill, readers),
			]);
			const exitCode = await exitP;
			const combined = out.text + err.text;
			// Truncation must reach the model: a capped stream killed the
			// process, a cut drain dropped output, and the final slice drops
			// the head — either way the output is incomplete and must not
			// look like a clean result.
			const truncated =
				out.truncated || err.truncated || drainCut || combined.length > MAX_OUTPUT;
			return {
				exit_code: timedOut ? null : exitCode,
				timed_out: timedOut || undefined,
				truncated: truncated || undefined,
				output: combined.slice(-MAX_OUTPUT),
			};
		},
	});
