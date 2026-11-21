// A delegation or linked subagent reports through its own
// settlement notices — never through prose. Each settlement becomes one
// `worker` report: the worker's claim, kept distinct from goblin's
// assessment (design/programs.md → Reports and stages). The stage
// routes a worker's claim to goblin, except a question, which goes
// straight to the operator.

import { log } from "./log.ts";
import type { ResponsibilityStore } from "./responsibilities.ts";
import { reportInputSchema, type ReportInput } from "./responsibility-reports.ts";
import type { Delegation, DelegationVerdict } from "./delegations.ts";

const MAX_REASON = 4000;
const clipTo = (s: string, max: number): string =>
	s.length <= max ? s : `${s.slice(0, max - 1)}…`;
const clip = (s: string): string => clipTo(s, MAX_REASON);

/** The report a delegation's settlement states. A delegation has no
 *  structured question, only a screen or report, so a blocked agent is
 *  goblin's to read and relay: no `question` means it waits for goblin. */
export function delegationReport(d: Delegation, verdict: DelegationVerdict, body: string): ReportInput {
	return settlementReport(`delegation #${d.id} ${d.name}`, verdict, body);
}

/** Shared status report for a settled delegation or linked subagent. */
export function settlementReport(tag: string, verdict: DelegationVerdict, body: string): ReportInput {
	switch (verdict) {
		case "done":
			return { state: "ready", reason: clip(`${tag} finished: ${body}`) };
		case "needs input":
			return { state: "blocked", reason: clip(`${tag} needs input: ${body}`) };
		case "failed":
			return { state: "failed", reason: clip(`${tag} failed: ${body}`) };
		case "stopped":
			return { state: "blocked", reason: clip(`${tag} stopped by the operator: ${body}`) };
	}
}

export function fileAgentChildReport(
	resps: Pick<ResponsibilityStore, "report" | "get">,
	child: {
		conversationId: string;
		type: string;
		responsibilityId: string | null;
		responsibilityRevision: number | null;
		settlements: number;
	},
	status: "queued" | "running" | "done" | "needs-input" | "failed" | "stopped",
	result: string | null,
): void {
	if (child.responsibilityId === null) return;
	if (status === "queued" || status === "running")
		throw new Error(`agent child ${child.conversationId}: cannot file unsettled status ${status}`);
	const verdict: DelegationVerdict = status === "needs-input" ? "needs input" : status;
	const body = result === null || result === "" ? "(no reply text)" : result;
	fileReport(resps, child.responsibilityId, settlementReport(`agent ${child.type} ${child.conversationId}`, verdict, body), {
		sourceKey: `agent:${child.conversationId}:${child.settlements + 1}:${status}`,
		revision: child.responsibilityRevision,
		logFields: { child: child.conversationId },
	});
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
