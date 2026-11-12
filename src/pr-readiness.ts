import { createHash } from "node:crypto";
import { z } from "zod";

export const githubIssueSchema = z.strictObject({
	repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	number: z.number().int().positive(),
});
export type GithubIssue = z.infer<typeof githubIssueSchema>;
export const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const verifierVerdictSchema = z.object({
	verdict: z.enum(["PASS", "PASS+NOTES", "FAIL"]),
	sha: commitShaSchema.nullable(),
	source: z.string().url(),
	author: z.string().nullable(),
	notes: z.string(),
	notesTruncated: z.boolean(),
});
export type VerifierVerdict = z.infer<typeof verifierVerdictSchema>;

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
			verifier: verifierVerdictSchema.nullable(),
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

/** Time is evidence, not a change: repeated observations must not wake a model. */
export function readinessKey(readiness: PrReadiness): string {
	const { observedAt: _, ...facts } = readiness;
	return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

export function readinessReasons(
	head: string,
	verifier: VerifierVerdict | null,
	ci: CheckedPr["ci"]["state"],
): string[] {
	const reasons: string[] = [];
	if (verifier === null) reasons.push("Missing verifier verdict");
	else {
		if (verifier.sha === null) reasons.push("Verifier comment has no full Checked-SHA");
		else if (verifier.sha !== head) reasons.push("Verifier verdict is for an older or different SHA");
		if (verifier.verdict === "FAIL") reasons.push("Verifier verdict is FAIL");
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
				? "PR readiness facts pass; PASS+NOTES still needs judgment on the notes. Merge still needs operator approval."
				: `Not ready: ${r.reasons.join("; ")}`;
	}
}
