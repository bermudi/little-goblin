import { tool } from "ai";
import { z } from "zod";

const MAX_OUTPUT = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

// Drain a pipe to EOF, capped — a runaway command that floods a stream gets
// killed instead of buffering forever.
async function collect(
	stream: ReadableStream<Uint8Array>,
	cap: number,
	onTruncate: () => void,
): Promise<{ text: string; truncated: boolean }> {
	const reader = stream.getReader();
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
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				proc.kill();
			}, timeout);
			const onAbort = () => proc.kill();
			abortSignal?.addEventListener("abort", onAbort, { once: true });
			try {
				const kill = () => proc.kill();
				const [out, err] = await Promise.all([
					collect(proc.stdout, MAX_OUTPUT, kill),
					collect(proc.stderr, MAX_OUTPUT, kill),
				]);
				const exitCode = await proc.exited;
				const combined = out.text + err.text;
				// Truncation must reach the model: a capped stream killed the
				// process, and the final slice drops the head — either way the
				// output is incomplete and must not look like a clean result.
				const truncated = out.truncated || err.truncated || combined.length > MAX_OUTPUT;
				return {
					exit_code: timedOut ? null : exitCode,
					timed_out: timedOut || undefined,
					truncated: truncated || undefined,
					output: combined.slice(-MAX_OUTPUT),
				};
			} finally {
				clearTimeout(timer);
				abortSignal?.removeEventListener("abort", onAbort);
			}
		},
	});
