import { createHash } from "node:crypto";
import { z } from "zod";

export const githubIssueSchema = z.strictObject({
	repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	number: z.number().int().positive(),
});
export type GithubIssue = z.infer<typeof githubIssueSchema>;
export const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const checkNameSchema = z.string().trim().min(1).max(100);
/** What code watches for one delegation: the issue whose closing PR it observes, and
 *  the commit checks (status context or check run name) that must pass on that PR's head. */
export const prWatchSchema = z.strictObject({
	issue: githubIssueSchema,
	checks: z.array(checkNameSchema).max(20)
		.refine((c) => new Set(c).size === c.length, "check names must be unique"),
});
export type PrWatch = z.infer<typeof prWatchSchema>;

export const requiredCheckSchema = z.object({
	name: checkNameSchema,
	state: z.enum(["passed", "pending", "failed", "missing"]),
	/** GitHub's raw state/conclusion per entry with this name (e.g. "SUCCESS", "FAILURE", "SKIPPED"); [] when missing. */
	detail: z.array(z.string()),
	/** Untrusted: status description / check run title of the entry that set `state`. */
	description: z.string().nullable(),
	/** Untrusted: status targetUrl / check run detailsUrl of the entry that set `state`. */
	url: z.string().nullable(),
	/** The non-minimized PR comment whose URL equals `url` exactly; untrusted text. */
	notes: z.object({
		source: z.string().url(),
		author: z.string().nullable(),
		text: z.string(), // first 6000 chars
		truncated: z.boolean(),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
	}).nullable(),
});
export type RequiredCheck = z.infer<typeof requiredCheckSchema>;

export const prReadinessSchema = z.object({
	observedAt: z.string().datetime(),
	issue: githubIssueSchema,
	source: z.string().url(),
	result: z.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("unavailable"),
			reason: z.string(),
		}),
		z.object({
			kind: z.literal("no-pr"),
			issueClosed: z.boolean(),
		}),
		z.object({
			kind: z.literal("ambiguous"),
			prs: z.array(z.string().url()),
		}),
		z.object({
			kind: z.literal("checked"),
			pr: z.string().url(),
			head: z.object({ sha: commitShaSchema, source: z.string().url() }),
			checks: z.array(requiredCheckSchema),
			ci: z.object({
				state: z.enum(["green", "pending", "red", "missing"]),
				sha: commitShaSchema,
				source: z.string().url(),
			}),
			ready: z.boolean(),
			reasons: z.array(z.string()),
		}),
	]),
});
export type PrReadiness = z.infer<typeof prReadinessSchema>;
export type CheckedPr = Extract<PrReadiness["result"], { kind: "checked" }>;

/** How old an observation must be before the watcher re-reads GitHub:
 *  the remote read is the expensive edge, not the 15s scan. */
export const READINESS_OBSERVE_MS = 60_000;

/** Time is evidence, not a change: repeated observations must not wake a model. */
export function readinessKey(readiness: PrReadiness): string {
	const { observedAt: _, ...facts } = readiness;
	return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

export function readinessReasons(checks: RequiredCheck[], ci: CheckedPr["ci"]["state"]): string[] {
	const reasons: string[] = [];
	for (const check of checks) {
		if (check.state === "missing") reasons.push(`Required check ${check.name} is missing on the current head`);
		else if (check.state === "pending") reasons.push(`Required check ${check.name} is pending on the current head`);
		else if (check.state === "failed") reasons.push(`Required check ${check.name} did not pass on the current head (${check.detail.join(", ")})`);
	}
	if (ci !== "green") reasons.push(`CI is ${ci} on the current head`);
	return reasons;
}

export function readinessSummary(readiness: PrReadiness): string {
	const r = readiness.result;
	switch (r.kind) {
		case "unavailable":
			return `Not ready: GitHub evidence unavailable — ${r.reason}`;
		case "no-pr":
			return `Not ready: ${r.issueClosed ? "issue is closed" : "no open PR closes the issue"}`;
		case "ambiguous":
			return "Not ready: multiple open PRs close the issue";
		case "checked":
			return r.ready
				? "PR readiness facts pass; read the required checks' notes before reporting. Merge still needs operator approval."
				: `Not ready: ${r.reasons.join("; ")}`;
	}
}
