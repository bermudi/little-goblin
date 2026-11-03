// A pi-durable run linked to a responsibility reports through its own
// terminal tools — finish, ask_operator — never through prose. Each
// settlement becomes one `worker` report: the worker's claim, kept
// distinct from goblin's assessment (design/programs.md → Reports and
// stages). The stage routes a worker's claim to goblin, except a
// question, which goes straight to the operator.

import { log } from "./log.ts";
import type { ResponsibilityStore } from "./responsibilities.ts";
import type { ReportInput } from "./responsibility-reports.ts";
import type { SubagentRun } from "./subagent-runs.ts";

const MAX_REASON = 4000;
const clip = (s: string): string => (s.length <= MAX_REASON ? s : `${s.slice(0, MAX_REASON - 1)}…`);

/** The report a settlement states, or null when it states nothing
 *  (still running, or stopped by goblin/the operator on purpose). */
export function runReport(row: SubagentRun): ReportInput | null {
	const tag = `${row.kind} run #${row.id}`;
	switch (row.status) {
		case "done": {
			const files = row.exportedFiles.length > 0 ? ` (exported: ${row.exportedFiles.join(", ")})` : "";
			return {
				state: "ready",
				reason: clip(`${tag} finished: ${row.result ?? "(no result text)"}${files}`),
			};
		}
		case "needs_input":
			// A crash-resolution hold is goblin's decision (subagent decide);
			// ask_operator is the worker's one question for the operator.
			return row.pendingApproval !== null
				? {
						state: "blocked",
						reason: clip(
							`${tag} needs a crash-resolution decision on ${row.pendingApproval.tool}: ${row.question ?? ""}`,
						),
					}
				: {
						state: "blocked",
						reason: clip(`${tag} asks the operator`),
						question: clip(row.question ?? "(empty question)"),
					};
		case "failed":
			return { state: "failed", reason: clip(`${tag} failed: ${row.error ?? "unknown error"}`) };
		default:
			return null;
	}
}

/** One settlement, one report: keyed by run, input revision and status,
 *  so a retried notice files nothing new. A closed responsibility
 *  refuses — the run outlived the work, which is logged, not an error. */
export function fileRunReport(
	resps: Pick<ResponsibilityStore, "report">,
	row: SubagentRun,
): void {
	if (row.responsibilityId === null) return;
	const input = runReport(row);
	if (input === null) return;
	const result = resps.report(row.responsibilityId, input, "worker", {
		sourceKey: `subagent:${row.id}:${row.inputRev}:${row.status}`,
	});
	if ("refused" in result) {
		log.warn("worker report not filed — responsibility refused it", {
			run: row.id,
			responsibility: row.responsibilityId,
			refused: result.refused,
		});
	}
}
