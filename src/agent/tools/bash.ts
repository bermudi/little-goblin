import { tool } from "ai";
import { spawnSync } from "node:child_process";
import { z } from "zod";

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
		execute: async ({ command, timeout_ms }) => {
			const timeout = Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
			const result = spawnSync("/bin/bash", ["-c", command], {
				cwd,
				encoding: "utf8",
				timeout,
				maxBuffer: MAX_OUTPUT * 2,
				env: process.env,
			});
			const output = ((result.stdout ?? "") + (result.stderr ?? "")).slice(-MAX_OUTPUT);
			if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
				return { error: "bash not found" };
			}
			const timedOut = result.signal === "SIGTERM" && result.error !== undefined;
			return {
				exit_code: timedOut ? null : result.status,
				timed_out: timedOut || undefined,
				output,
			};
		},
	});
