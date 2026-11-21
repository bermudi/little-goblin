import { join } from "node:path";
import { log } from "./log.ts";
import type { Delegation } from "./delegations.ts";
import type { DelegationLifecycleDeps } from "./delegation-lifecycle.ts";

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
		reportPathFor(deps, d)
	);
}

// Cleanup has no watcher fallback: close each bound workspace once, best-effort,
// without replacing the stop/failed result with a cleanup error.
export async function killQuietly(
	deps: DelegationLifecycleDeps,
	id: number,
	terminal: string,
): Promise<void> {
	try {
		await deps.hc.kill(terminal);
	} catch (err) {
		log.warn("delegation terminal kill failed", err, {
			delegation: id,
			terminal,
		});
	}
}

