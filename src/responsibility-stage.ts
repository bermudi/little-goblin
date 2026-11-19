// Whom a responsibility waits for — derived from its status snapshot and open
// obligations, never stored. The feed, Attention and scheduler share this one
// definition (design/programs.md → Snapshots and obligations).
import type { ResponsibilityReport, ObligationKind } from "./responsibility-reports.ts";
import { obligationKind } from "./responsibility-reports.ts";
import type { PromptOperation, Responsibility } from "./responsibility-types.ts";

export type WaitsFor = "operator" | "goblin" | "worker" | "nobody";

export type StageName =
	| "closed"
	| "paused"
	| "delivery-uncertain"
	| "question"
	| "assess"
	| "review"
	| "blocked"
	| "failed"
	| "waiting"
	| "working";

export interface ResponsibilityStage {
	waitsFor: WaitsFor;
	stage: StageName;
	reason: string;
	since: { reportId: number; createdAt: string } | null;
}

export interface StageReports {
	/** Newest non-worker report — the replaceable status snapshot. */
	status: ResponsibilityReport | null;
	/** Every open obligation, oldest first. */
	open: readonly ResponsibilityReport[];
}

interface OpenQuestion {
	kind: "question";
	question: string;
	waitsFor: "operator" | "goblin";
	stale: boolean;
	report: ResponsibilityReport;
}

interface OpenClaim {
	kind: "claim";
	waitsFor: "goblin";
	stale: boolean;
	report: ResponsibilityReport;
}

export type OpenObligation = OpenQuestion | OpenClaim;

export function openObligations(
	resp: Pick<Responsibility, "revision">,
	open: readonly ResponsibilityReport[],
): OpenObligation[] {
	return open.flatMap((report): OpenObligation[] => {
		const kind = obligationKind(report);
		if (kind === null) return [];
		const stale = report.revision !== resp.revision;
		if (kind === "question") {
			if (report.question === null) return [];
			return [{
				kind: "question",
				question: report.question,
				waitsFor: stale ? "goblin" : "operator",
				stale,
				report,
			}];
		}
		return [{ kind: "claim", waitsFor: "goblin", stale, report }];
	});
}

const since = (report: ResponsibilityReport | null) =>
	report === null ? null : { reportId: report.reportId, createdAt: report.createdAt };

export function responsibilityStage(
	resp: Pick<Responsibility, "status" | "revision">,
	reports: StageReports,
	operations: readonly Pick<PromptOperation, "operationId" | "state">[],
): ResponsibilityStage {
	const status = reports.status;
	const closed = (reason: string): ResponsibilityStage => ({
		waitsFor: "nobody",
		stage: "closed",
		reason,
		since: since(status),
	});
	if (resp.status === "completed" || resp.status === "cancelled") {
		return closed(
			status !== null && (status.state === "done" || status.state === "dropped")
				? `${status.state}: ${status.reason}`
				: `responsibility ${resp.status}`,
		);
	}
	if (resp.status === "paused") {
		return { waitsFor: "operator", stage: "paused", reason: "paused by the operator", since: null };
	}
	// An unconfirmed send blocks further sends to that agent until goblin
	// inspects and reconciles it — this is goblin's move, not the operator's.
	const uncertain = operations.find((op) => op.state === "uncertain");
	if (uncertain !== undefined) {
		return {
			waitsFor: "goblin",
			stage: "delivery-uncertain",
			reason: `send ${uncertain.operationId} delivery unconfirmed — inspect and reconcile`,
			since: null,
		};
	}
	const open = openObligations(resp, reports.open);
	const currentQuestions = open.filter(
		(obligation): obligation is OpenQuestion => obligation.kind === "question" && !obligation.stale,
	);
	const staleQuestions = open.filter(
		(obligation): obligation is OpenQuestion => obligation.kind === "question" && obligation.stale,
	);
	const claims = open.filter((obligation): obligation is OpenClaim => obligation.kind === "claim");
	// A question waits on the operator whoever asked it. Oldest comes first;
	// keep the remaining count visible.
	if (currentQuestions.length > 0) {
		const first = currentQuestions[0]!;
		const remaining =
			currentQuestions.length > 1 ? ` (+${currentQuestions.length - 1} more open questions)` : "";
		return {
			waitsFor: "operator",
			stage: "question",
			reason: `${first.question}${remaining}`,
			since: since(first.report),
		};
	}
	// A question from before a correction is goblin's to re-ask or resolve;
	// the correction alone never answers it.
	if (staleQuestions.length > 0) {
		const first = staleQuestions[0]!;
		const remaining =
			staleQuestions.length > 1 ? ` (+${staleQuestions.length - 1} more)` : "";
		return {
			waitsFor: "goblin",
			stage: "assess",
			reason: `operator corrected since the question — re-ask or resolve: ${first.question}${remaining}`,
			since: since(first.report),
		};
	}
	// A worker's claim is goblin's to check before anything reaches the
	// operator or closes.
	if (claims.length > 0) {
		const first = claims[0]!;
		const remaining =
			claims.length > 1
				? ` (+${claims.length - 1} more unassessed worker claims)`
				: "";
		return {
			waitsFor: "goblin",
			stage: "assess",
			reason: `${first.report.reason}${remaining}`,
			since: since(first.report),
		};
	}
	// A correction does not resolve obligations, but an overtaken snapshot
	// still needs goblin to assess the changed understanding.
	if (status !== null && status.revision !== resp.revision) {
		return {
			waitsFor: "goblin",
			stage: "assess",
			reason: "operator corrected since the last report",
			since: since(status),
		};
	}
	if (status !== null) {
		switch (status.state) {
			case "ready":
				return { waitsFor: "operator", stage: "review", reason: status.reason, since: since(status) };
			case "blocked":
				return { waitsFor: "operator", stage: "blocked", reason: status.reason, since: since(status) };
			case "failed":
				return { waitsFor: "operator", stage: "failed", reason: status.reason, since: since(status) };
			case "waiting":
				return {
					waitsFor: "nobody",
					stage: "waiting",
					reason: status.resumeWhen ?? status.reason,
					since: since(status),
				};
			default:
				break;
		}
	}
	return {
		waitsFor: "worker",
		stage: "working",
		reason:
			status !== null && (status.state === "done" || status.state === "dropped")
				? `resumed after ${status.state}`
				: status?.reason ?? "no report yet",
		since: since(status),
	};
}
