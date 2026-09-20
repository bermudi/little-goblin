import { tool } from "ai";
import { z } from "zod";
import { boundedRun, spawnProc, type BoundedProc } from "../../proc.ts";
import { truncateTail } from "./truncate.ts";

const MAX_OUTPUT = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

export const bashTool = (cwd: string) =>
	tool({
		description:
			"Run a shell command in the conversation's working directory. Returns combined stdout/stderr and the exit code.",
		inputSchema: z.object({
			command: z.string(),
			timeout_ms: z.number().int().positive().optional(),
		}),
		execute: async ({ command, timeout_ms }, { abortSignal }) => {
			let proc: Bun.ReadableSubprocess;
			try {
				proc = spawnProc(["/bin/bash", "-c", command], cwd);
			} catch (err) {
				return { error: `spawn failed: ${(err as Error).message}` };
			}
			const result: BoundedProc = await boundedRun(proc, {
				timeoutMs: Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
				maxOutput: MAX_OUTPUT,
				...(abortSignal ? { abortSignal } : {}),
			});
			const combined = result.stdout + result.stderr;
			// Truncation must reach the model: a capped stream killed the
			// process, a cut drain dropped output, and the tail cut drops
			// the head — either way the output is incomplete and must not
			// look like a clean result.
			const tail = truncateTail(combined, MAX_OUTPUT);
			const truncated = result.truncated || tail.truncated;
			return {
				exit_code: result.timedOut ? null : result.exitCode,
				timed_out: result.timedOut || undefined,
				truncated: truncated || undefined,
				output: tail.content,
			};
		},
	});
