// A delegation linked to a responsibility reports through its own
// terminal notices — never through prose. Each settlement becomes one
// `worker` report: the worker's claim, kept distinct from goblin's
// assessment (design/programs.md → Reports and stages). The stage
// routes a worker's claim to goblin, except a question, which goes
// straight to the operator.

import { log } from "./log.ts";
import type { ResponsibilityStore } from "./responsibilities.ts";
import { reportInputSchema, type ReportInput } from "./responsibility-reports.ts";
import type { Delegation, DelegationVerdict } from "./delegations.ts";
import { READINESS_OBSERVE_MS, readinessSummary, type PrReadiness } from "./pr-readiness.ts";

const MAX_REASON = 4000;
const clipTo = (s: string, max: number): string =>
	s.length <= max ? s : `${s.slice(0, max - 1)}…`;
const clip = (s: string): string => clipTo(s, MAX_REASON);

/** The report a delegation's settlement states. A delegation has no
 *  structured question, only a screen or report, so a blocked agent is
 *  goblin's to read and relay: no `question` means it waits for goblin. */
export function delegationReport(
	d: Delegation,
	verdict: DelegationVerdict,
	body: string,
	readiness?: PrReadiness,
): ReportInput {
	const tag = `delegation #${d.id} ${d.name}`;
	if (readiness !== undefined) {
		const r = readiness.result;
		const pending = r.kind === "checked" && r.ci.state === "pending";
		return {
			state: verdict === "failed" ? "failed" : verdict !== "done" ? "blocked"
				: r.kind === "checked" && r.ready ? "ready" : pending ? "waiting" : "blocked",
			reason: clip(`${readinessSummary(readiness)}\n${tag} ${verdict}: ${body}`),
			// Pending readiness resumes at the next observation window: the
			// code poller re-reads GitHub, not the model, and a resumeWhen
			// must be a future time — a stale observedAt is clamped to now.
			...(verdict === "done" && pending
				? {
						resumeWhen: new Date(
							Math.max(Date.now(), Date.parse(readiness.observedAt)) +
								2 * READINESS_OBSERVE_MS,
						).toISOString(),
					}
				: {}),
			evidence: [
				{ item: "Closing PR", ref: readiness.source, checked: r.kind === "checked" ? r.pr : readinessSummary(readiness) },
				...(r.kind !== "checked" ? [] : [
					{ item: "PR head", ref: r.head.source, checked: r.head.sha },
					{ item: "Verifier verdict", ref: r.verifier?.source ?? r.pr,
						checked: r.verifier === null ? "Missing verdict" : `${r.verifier.verdict}; Checked-SHA: ${r.verifier.sha ?? "missing"}` },
					{ item: "CI on PR head", ref: r.ci.source, checked: `${r.ci.state}; SHA: ${r.ci.sha}` },
				]),
			],
		};
	}
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

/** One settlement, one report. The key carries the prompt and the seq
 *  baseline: a retried notice repeats both and files nothing new, while a
 *  follow-up or a later dialog on the same prompt moves one of them. */
export function fileDelegationReport(
	resps: Pick<ResponsibilityStore, "report" | "get">,
	d: Delegation,
	verdict: DelegationVerdict,
	body: string,
	readiness?: PrReadiness,
): void {
	if (d.responsibilityId === null) return;
	fileReport(resps, d.responsibilityId, delegationReport(d, verdict, body, readiness), {
		sourceKey: `delegation:${d.id}:${d.promptedAt}:${d.baselineSeq ?? "pending"}:${verdict}${readiness === undefined ? "" : `:readiness:${d.readinessVersion}`}`,
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
