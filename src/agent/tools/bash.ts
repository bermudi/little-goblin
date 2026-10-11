import { tool } from "ai";
import { z } from "zod";
import { boundedRun, spawnProc, type BoundedProc } from "../../proc.ts";
import { paths } from "../../config.ts";
import { truncateTail } from "./truncate.ts";

const MAX_OUTPUT = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

export const bashTool = (cwd: string) =>
	tool({
		// Two forms, keyed on the workspace — never the cwd embedded: the
		// description is a frozen prompt input, and the doctor shim is
		// `../doctor` only from the workspace; a project cwd needs it
		// absolute (design/projects.md).
		description:
			cwd === paths.workspace()
				? "Run a shell command in the deployment workspace — the fixed working directory shared by every conversation. Use `cd` inside the command to work elsewhere. Returns combined stdout/stderr and the exit code. For dependency health checks, run `../doctor --json`; diagnosis does not authorize repairs or restarts."
				: `Run a shell command in this conversation's working directory — the project directory the environment line names. Use \`cd\` inside the command to work elsewhere. Returns combined stdout/stderr and the exit code. For dependency health checks, run \`${paths.doctorShim()} --json\`; diagnosis does not authorize repairs or restarts.`,
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
