import { z } from "zod";
import { BoundaryError } from "./boundary-error.ts";
import { log } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";
import type { PrSnapshot } from "./watches.ts";

export type GitHubRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const checkSchema = z.object({
	__typename: z.string().optional(),
	name: z.string().optional(),
	context: z.string().optional(),
	status: z.string().optional(),
	conclusion: z.string().nullable().optional(),
	state: z.string().optional(),
});
const prSchema = z.object({
	state: z.enum(["OPEN", "CLOSED", "MERGED"]),
	headRefOid: z.string(),
	statusCheckRollup: z.array(checkSchema).nullable().optional(),
});

const defaultRunner: GitHubRunner = async (args) => {
	const proc = spawnProc(["gh", ...args]);
	const result = await boundedRun(proc, { timeoutMs: 45_000, maxOutput: 1 << 20 });
	return {
		code: result.exitCode ?? -1,
		stdout: result.stdout,
		stderr: result.stderr,
	};
};

export function makeGitHub(run: GitHubRunner = defaultRunner) {
	return {
		async readPr(repository: string, number: number): Promise<PrSnapshot> {
			const target = `${repository}#${number}`;
			const result = await run(["pr", "view", String(number), "--repo", repository, "--json", "state,headRefOid,statusCheckRollup"]);
			if (result.code !== 0) {
				throw new BoundaryError("gh", "transient", `gh pr view failed (${result.code}): ${result.stderr.trim().slice(0, 200)}`);
			}
			let raw: unknown;
			try {
				raw = JSON.parse(result.stdout);
			} catch (cause) {
				throw new BoundaryError("gh", "fatal", "gh pr view returned malformed JSON", { cause });
			}
			let parsed: z.infer<typeof prSchema>;
			try {
				parsed = prSchema.parse(raw);
			} catch (cause) {
				throw new BoundaryError("gh", "fatal", "gh pr view returned an unexpected shape", { cause });
			}
			const snapshot: PrSnapshot = {
				state: parsed.state,
				headSha: parsed.headRefOid,
				checks: (parsed.statusCheckRollup ?? []).map((check) => ({
					name: check.name ?? check.context ?? "",
					status: check.status ?? (
						check.state === "PENDING" || check.state === "EXPECTED"
							? "PENDING"
							: "COMPLETED"
					),
					conclusion: check.conclusion ?? (
						check.state !== undefined && check.state !== "PENDING" && check.state !== "EXPECTED"
							? check.state
							: null
					),
				})).sort((a, b) => a.name.localeCompare(b.name)),
			};
			log.info("github call", { verb: "pr view", target, outcome: "ok", checks: snapshot.checks.length });
			return snapshot;
		},
	};
}

export type GitHub = ReturnType<typeof makeGitHub>;
