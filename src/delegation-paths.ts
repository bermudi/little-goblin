// The delegation family's shared predicates: the issue-lead row test
// and the prompt suffix a lead's message carries. Results ride the
// T3 thread's messages, watched through `thread show`.

import type { Delegation } from "./delegations.ts";
import type { GithubIssue } from "./pr-readiness.ts";

export function isIssueLead(d: Delegation): d is Delegation & { issue: GithubIssue; responsibilityId: string } {
	return d.role === "lead" && d.issue !== null && d.responsibilityId !== null;
}

// The lead's message names the verifier contract goblin's readiness
// check enforces (design/delegation.md → PR readiness is observed).
export function leadNote(d: Delegation): string {
	if (!isIssueLead(d)) return "";
	return `\nPR readiness is observed by code for ${d.issue.repository}#${d.issue.number}. The verifier's PR comment must open with PASS, PASS+NOTES, or FAIL and have exactly one standalone line "Checked-SHA: <full 40-character lowercase commit SHA>". Post a new verdict for each checked head. PASS+NOTES does not waive the notes or authorize a merge.`;
}
