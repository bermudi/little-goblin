// Target/report seam of the delegation family: which herdr adapter a row
// addresses, where its report lives, and the issue-lead row predicate.

import { join } from "node:path";
import { log } from "./log.ts";
import { attachHintFor, type Herdr } from "./herdr.ts";
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
// A vanished target is unreachable; never silently retarget its row.
export class TargetGoneError extends Error {
	constructor(readonly target: string) {
		super(
			`delegation target "${target}" is no longer in config — restore the machines entry, or stop the row knowing the agent may still run host-side`,
		);
		this.name = "TargetGoneError";
	}
}

export function herdrFor(deps: DelegationLifecycleDeps, target: string | null): Herdr {
	if (target === null) return deps.herdr;
	const t = deps.targets.get(target);
	if (t === undefined) {
		throw new TargetGoneError(target);
	}
	return t.herdr;
}

export function attachHintForRow(deps: DelegationLifecycleDeps, target: string | null): string {
	if (target === null) return attachHintFor(null);
	const t = deps.targets.get(target);
	return attachHintFor(t === undefined ? null : t);
}

// Machine rows carry target-side cwd/report paths; null means the local
// report machinery applies.
export function machineRootFor(deps: DelegationLifecycleDeps, target: string | null): string | null {
	if (target === null) return null;
	const t = deps.targets.get(target);
	if (t === undefined) throw new TargetGoneError(target);
	if (t.machine === undefined) return null;
	return (t.root ?? "~").replace(/\/+$/, "") || "/";
}

export function reportPathFor(deps: DelegationLifecycleDeps, d: Delegation): string {
	// A vanished label leaves no trustworthy report path.
	if (d.target !== null && !deps.targets.has(d.target)) {
		return `(unavailable — target "${d.target}" is no longer in config; restore its machines entry)`;
	}
	// Machine paths are target-side instructions; freshness attribution never trusts
	// a local stat of that path.
	const machineRoot = machineRootFor(deps, d.target);
	if (machineRoot !== null) return `${machineRoot}/delegations/${d.id}/report.md`;
	return join(reportDirFor(deps, d.id), "report.md");
}

// Prompts name the report path and, for machines, ask the agent to create it;
// launch only prepares the local directory.
export function reportNote(deps: DelegationLifecycleDeps, d: Delegation): string {
	return (
		REPORT_NOTE +
		reportPathFor(deps, d) +
		(machineRootFor(deps, d.target) !== null ? " (create the directory if needed)" : "") +
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
	target: string | null,
): Promise<void> {
	try {
		await herdrFor(deps, target).closeWorkspace(workspaceId);
	} catch (err) {
		log.warn("delegation workspace close failed", err, {
			delegation: id,
		});
	}
}

export function isIssueLead(d: Delegation): d is Delegation & { issue: GithubIssue; responsibilityId: string } {
	return d.role === "lead" && d.issue !== null && d.responsibilityId !== null;
}
