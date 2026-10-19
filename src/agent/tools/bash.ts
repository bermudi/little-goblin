import { tool } from "ai";
import { z } from "zod";
import { boundedRun, spawnProc, type BoundedProc } from "../../proc.ts";
import { paths } from "../../config.ts";
import { log } from "../../log.ts";
import { truncatedFooter, trySpill, windowText } from "./truncate.ts";

// Runaway capture guard (the process is killed over it, proc.ts). 4 MiB keeps
// the spill inside read_file's 8 MiB ceiling.
const MAX_CAPTURE = 4 * 1024 * 1024;
const OUTPUT_BUDGET = 15_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

export const bashTool = (cwd: string) =>
	tool({
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
				maxOutput: MAX_CAPTURE,
				...(abortSignal ? { abortSignal } : {}),
			});
			const combined = result.stdout + result.stderr;
			let output = combined;
			let truncated = result.truncated;
			if (combined.length > OUTPUT_BUDGET) {
				const window = windowText(combined, OUTPUT_BUDGET, 0.25).window;
				const file = trySpill(paths.bashcache(), combined);
				if (file !== null) {
					log.info("bash output spilled", {
						file,
						chars: combined.length,
						captureCut: result.truncated,
					});
				}
				output = window + truncatedFooter(file, combined.length);
				truncated = true;
			}
			if (result.truncated) {
				output +=
					"\n\n[output exceeded the capture cap or was cut before it finished — the output above and any saved file are incomplete; background processes may still be running]";
			}
			return {
				exit_code: result.timedOut ? null : result.exitCode,
				timed_out: result.timedOut || undefined,
				truncated: truncated || undefined,
				output,
			};
		},
	});
