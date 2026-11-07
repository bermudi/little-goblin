// A pi-durable run linked to a responsibility reports through its own
// terminal tools — finish, ask_operator — never through prose. Each
// settlement becomes one `worker` report: the worker's claim, kept
// distinct from goblin's assessment (design/programs.md → Reports and
// stages). The stage routes a worker's claim to goblin, except a
// question, which goes straight to the operator.

import { basename } from "node:path";
import { log } from "./log.ts";
import type { ResponsibilityStore } from "./responsibilities.ts";
import { reportInputSchema, type ReportInput } from "./responsibility-reports.ts";
import type { Delegation } from "./delegations.ts";
import type { DelegationVerdict } from "./delegation-lifecycle.ts";
import type { SubagentRun } from "./subagent-runs.ts";

const MAX_REASON = 4000;
const clipTo = (s: string, max: number): string =>
	s.length <= max ? s : `${s.slice(0, max - 1)}…`;
const clip = (s: string): string => clipTo(s, MAX_REASON);
const MAX_QUESTION = 2000;

/** The report a settlement states, or null when it states nothing
 *  (still running, or stopped by goblin/the operator on purpose). */
export function runReport(row: SubagentRun): ReportInput | null {
	const tag = `${row.kind} run #${row.id}`;
	switch (row.status) {
		case "done":
			// Exported files are the run's artifacts — the feed links them
			// rather than burying paths in the reason text.
			return {
				state: "ready",
				reason: clip(`${tag} finished: ${row.result ?? "(no result text)"}`),
				...(row.exportedFiles.length === 0
					? {}
					: {
							artifacts: row.exportedFiles
								.slice(0, 16)
								.map((f) => ({ title: clipTo(basename(f), 200), ref: clipTo(f, 2000) })),
						}),
			};
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
						question: clipTo(row.question ?? "(empty question)", MAX_QUESTION),
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
	resps: Pick<ResponsibilityStore, "report" | "get">,
	row: SubagentRun,
): void {
	if (row.responsibilityId === null) return;
	const input = runReport(row);
	if (input === null) return;
	fileReport(resps, row.responsibilityId, input, {
		sourceKey: `subagent:${row.id}:${row.inputRev}:${row.status}`,
		revision: row.responsibilityRevision,
		logFields: { run: row.id },
	});
}

/** The report a delegation's settlement states. A delegation has no
 *  structured question, only a screen or report, so a blocked agent is
 *  goblin's to read and relay: no `question` means it waits for goblin. */
export function delegationReport(
	d: Delegation,
	verdict: DelegationVerdict,
	body: string,
): ReportInput {
	const tag = `delegation #${d.id} ${d.name}`;
	switch (verdict) {
		case "done":
			return { state: "ready", reason: clip(`${tag} finished: ${body}`) };
		case "needs input":
			return { state: "blocked", reason: clip(`${tag} needs input: ${body}`) };
		case "failed":
			return { state: "failed", reason: clip(`${tag} failed: ${body}`) };
	}
}

/** One settlement, one report. The key carries the prompt and the seq
 *  baseline: a retried notice repeats both and files nothing new, while a
 *  follow-up or a later dialog on the same prompt moves one of them. */
export function fileDelegationReport(
	resps: Pick<ResponsibilityStore, "report" | "get">,
	d: Delegation,
	verdict: DelegationVerdict,
	body: string,
): void {
	if (d.responsibilityId === null) return;
	fileReport(resps, d.responsibilityId, delegationReport(d, verdict, body), {
		sourceKey: `delegation:${d.id}:${d.promptedAt}:${d.baselineSeq ?? "pending"}:${verdict}`,
		revision: d.responsibilityRevision,
		logFields: { delegation: d.id },
	});
}

function fileReport(
	resps: Pick<ResponsibilityStore, "report" | "get">,
	responsibilityId: string,
	input: ReportInput,
	opts: { sourceKey: string; revision: number | null; logFields: Record<string, unknown> },
): void {
	// These can never succeed on retry, and a throw here holds the notice
	// back, so the conversation would never wake. The notice itself still
	// carries the worker's claim. Store errors still throw and retry.
	if (resps.get(responsibilityId) === null) {
		log.warn("worker report not filed — responsibility is gone", {
			...opts.logFields,
			responsibility: responsibilityId,
		});
		return;
	}
	const parsed = reportInputSchema.safeParse(input);
	if (!parsed.success) {
		log.error("worker report not filed — invalid report", parsed.error, {
			...opts.logFields,
			responsibility: responsibilityId,
		});
		return;
	}
	const result = resps.report(responsibilityId, parsed.data, "worker", {
		sourceKey: opts.sourceKey,
		revision: opts.revision,
	});
	if ("refused" in result) {
		log.warn("worker report not filed — responsibility refused it", {
			...opts.logFields,
			responsibility: responsibilityId,
			refused: result.refused,
		});
	}
}
