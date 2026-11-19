// Report seam of the delegation family: where a row's report lives and
// the issue-lead row predicate. Every delegation runs in goblin's own
// local herdr session — there is no target dimension.

import { join } from "node:path";
import { log } from "./log.ts";
import type { Delegation } from "./delegations.ts";
import type { DelegationLifecycleDeps } from "./delegation-lifecycle.ts";
import type { GithubIssue } from "./pr-readiness.ts";

// The report file is the durable result channel; screen output is the fallback.
const REPORT_NOTE =
	"\n\nWhen you are completely finished, write your final report (what you did, what's left, anything you need from the operator) as Markdown to ";

// One report path feeds the prompt, freshness check, and notice body.
export function reportDirFor(deps: DelegationLifecycleDeps, id: number): string {
	return join(deps.delegationsDir, String(id));
}

export function reportPathFor(deps: DelegationLifecycleDeps, d: Delegation): string {
	return join(reportDirFor(deps, d.id), "report.md");
}

// Prompts name the report path; launch prepares the local directory.
export function reportNote(deps: DelegationLifecycleDeps, d: Delegation): string {
	return (
		REPORT_NOTE +
		reportPathFor(deps, d) +
		(isIssueLead(d)
			? `\nPR readiness is observed by code for ${d.issue.repository}#${d.issue.number}. The verifier's PR comment must open with PASS, PASS+NOTES, or FAIL and have exactly one standalone line "Checked-SHA: <full 40-character lowercase commit SHA>". Post a new verdict for each checked head. PASS+NOTES does not waive the notes or authorize a merge.`
			: "")
	);
}

// Cleanup has no watcher fallback: close each bound workspace once, best-effort,
// without replacing the stop/failed result with a cleanup error.
export async function closeWorkspaceQuietly(
	deps: DelegationLifecycleDeps,
	id: number,
	workspaceId: string,
): Promise<void> {
	try {
		await deps.herdr.closeWorkspace(workspaceId);
	} catch (err) {
		log.warn("delegation workspace close failed", err, {
			delegation: id,
		});
	}
}

export function isIssueLead(d: Delegation): d is Delegation & { issue: GithubIssue; responsibilityId: string } {
	return d.role === "lead" && d.issue !== null && d.responsibilityId !== null;
}
</content>
</invoke>ipl>type="string"<|sep|>/home/daniel/.t3/worktrees/little-goblin/t3-cdafb2a8-b4bf239980be1e0f/src/delegation-paths.ts