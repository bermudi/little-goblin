import { readinessReasons, type CheckedPr, type PrReadiness } from "../pr-readiness.ts";
import { createHash } from "node:crypto";

export function prReadinessFixture(
	ci: CheckedPr["ci"]["state"] = "pending",
): PrReadiness & { result: CheckedPr } {
	const head = "a".repeat(40);
	const pr = "https://github.com/owner/repo/pull/8";
	const verifier = {
		verdict: "PASS" as const, sha: head, source: `${pr}#issuecomment-1`,
		author: "verifier", notes: `PASS\nChecked-SHA: ${head}`,
		notesTruncated: false,
		notesDigest: createHash("sha256").update(`PASS\nChecked-SHA: ${head}`).digest("hex"),
	};
	const reasons = readinessReasons(head, verifier, ci);
	return {
		issue: { repository: "owner/repo", number: 7 },
		source: "https://github.com/owner/repo/issues/7",
		observedAt: new Date().toISOString(),
		result: {
			kind: "checked", pr, head: { sha: head, source: `${pr}/commits/${head}` },
			verifier, ci: { state: ci, sha: head, source: `${pr}/checks` },
			ready: reasons.length === 0, reasons,
		},
	};
}
