// Whom a responsibility waits for — derived, never stored. One
// ordered table, first match wins (design/programs.md → Reports and
// stages; borrowed from dsh-superagent's Ticket stages). The feed,
// Attention and the scheduler all read this one definition, so "needs
// the operator" cannot mean two things.

import type { PromptOperation, Responsibility } from "./responsibilities.ts";
import type { ResponsibilityReport } from "./responsibility-reports.ts";

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
}

export function responsibilityStage(
	resp: Pick<Responsibility, "status" | "revision">,
	latest: ResponsibilityReport | null,
	operations: readonly Pick<PromptOperation, "operationId" | "state">[],
): ResponsibilityStage {
	if (resp.status === "completed" || resp.status === "cancelled") {
		return {
			waitsFor: "nobody",
			stage: "closed",
			reason:
				latest !== null && (latest.state === "done" || latest.state === "dropped")
					? `${latest.state}: ${latest.reason}`
					: `responsibility ${resp.status}`,
		};
	}
	if (resp.status === "paused") {
		return { waitsFor: "operator", stage: "paused", reason: "paused by the operator" };
	}
	// An unconfirmed send blocks every further send to that agent until
	// goblin inspects and reconciles it — goblin's move, not the operator's.
	const uncertain = operations.find((op) => op.state === "uncertain");
	if (uncertain !== undefined) {
		return {
			waitsFor: "goblin",
			stage: "delivery-uncertain",
			reason: `send ${uncertain.operationId} delivery unconfirmed — inspect and reconcile`,
		};
	}
	// A report stated against an older revision no longer holds: the
	// operator's correction bumped the revision.
	const current = latest !== null && latest.revision === resp.revision ? latest : null;
	// Whether the correction answered the report is goblin's to judge: an
	// unrelated correction must not silently erase an open question, and
	// no worker is implied to be running.
	if (latest !== null && current === null) {
		return {
			waitsFor: "goblin",
			stage: "assess",
			reason:
				latest.question !== null
					? `operator corrected since the last report — re-ask or resolve: ${latest.question}`
					: "operator corrected since the last report",
		};
	}
	if (current !== null) {
		if (current.question !== null) {
			return { waitsFor: "operator", stage: "question", reason: current.question };
		}
		// A worker's claim — finished, failed, held — is goblin's to check
		// before anything reaches the operator or closes.
		if (current.reporter === "worker") {
			return { waitsFor: "goblin", stage: "assess", reason: current.reason };
		}
		switch (current.state) {
			case "ready":
				return { waitsFor: "operator", stage: "review", reason: current.reason };
			case "blocked":
				return { waitsFor: "operator", stage: "blocked", reason: current.reason };
			case "failed":
				return { waitsFor: "operator", stage: "failed", reason: current.reason };
			case "waiting":
				return {
					waitsFor: "nobody",
					stage: "waiting",
					reason: current.resumeWhen ?? current.reason,
				};
			default:
				break;
		}
	}
	return {
		waitsFor: "worker",
		stage: "working",
		reason:
			current !== null
				? current.state === "done" || current.state === "dropped"
					? `resumed after ${current.state}`
					: current.reason
				: "no report yet",
	};
}
