// Channel-neutral owner for the program grant boundary. A transport
// posts the immutable candidate and renders controls; this owner is the
// only path that mints grant-time hook credentials and asks the store
// to decide. The hook URL is returned to the authenticated surface
// that requested approval — it never enters model context or history.

import { hookTokenHash, hookUrl, newHookToken } from "./program-hook.ts";
import type { ProgramProposal, ProposalRefusal } from "./program-proposals.ts";
import type { Program, ProgramsStore } from "./programs.ts";
import type { DecisionActor } from "./targets.ts";

export type ProgramDecision = "approve" | "reject";

export type ProgramDecisionOutcome =
	| { kind: "activated"; proposal: ProgramProposal; program: Program; hookUrl?: string }
	| { kind: "rejected"; proposal: ProgramProposal }
	| { kind: "refused"; proposal: ProgramProposal | null; refusal: ProposalRefusal }
	| { kind: "needs-public-url"; proposal: ProgramProposal };

export interface ProgramApprovalDeps {
	programs: Pick<ProgramsStore, "get" | "proposals">;
	publicUrl(): string | undefined;
	/** Posts the complete immutable candidate to the proposal's target. */
	present(proposal: ProgramProposal): Promise<void>;
	now?(): Date;
}

export interface ProgramApproval {
	requestApproval(proposal: ProgramProposal): Promise<void>;
	decide(id: number, action: ProgramDecision, actor: DecisionActor): Promise<ProgramDecisionOutcome>;
	pending(): ProgramProposal[];
	candidate(proposal: ProgramProposal): ProgramCandidate | null;
}

export function startProgramApproval(deps: ProgramApprovalDeps): ProgramApproval {
	return {
		async requestApproval(proposal) {
			await deps.present(proposal);
		},
		async decide(id, action, actor) {
			const proposal = deps.programs.proposals.get(id);
			if (proposal === null) return { kind: "refused", proposal: null, refusal: "gone" };
			if (proposal.state !== "pending") {
				return {
					kind: "refused",
					proposal,
					refusal: proposal.state === "superseded" ? "superseded" : "decided",
				};
			}
			const now = deps.now?.() ?? new Date();
			if (action === "reject") {
				const outcome = deps.programs.proposals.reject(id, actor, now);
				return outcome.kind === "rejected"
					? outcome
					: { kind: "refused", proposal: outcome.proposal, refusal: outcome.refusal };
			}

			// Mint the raw token only after publicUrl exists and only at
			// grant time. The caller receives the URL once for private
			// presentation; only its hash reaches durable state.
			const wantsHook = proposalRequestsHook(proposal);
			const base = wantsHook ? deps.publicUrl() : undefined;
			if (wantsHook && base === undefined) return { kind: "needs-public-url", proposal };
			const token = wantsHook ? newHookToken() : undefined;
			const outcome = deps.programs.proposals.approve(id, actor, {
				...(token !== undefined ? { hookHash: hookTokenHash(token) } : {}),
				now,
			});
			if (outcome.kind !== "activated") {
				return { kind: "refused", proposal: outcome.proposal, refusal: outcome.refusal };
			}
			return {
				kind: "activated",
				proposal: outcome.proposal,
				program: outcome.program,
				...(token !== undefined ? { hookUrl: hookUrl(base!, token) } : {}),
			};
		},
		pending() {
			return deps.programs.proposals.pending();
		},
		candidate(proposal) {
			return proposalCandidate(deps.programs, proposal);
		},
	};
}

export function proposalRequestsHook(proposal: ProgramProposal): boolean {
	return proposal.kind === "create" ? proposal.draft?.hook === true : proposal.patch?.hook === true;
}

export function refusalText(refusal: ProposalRefusal): string {
	switch (refusal) {
		case "gone":
			return "proposal gone";
		case "decided":
			return "already decided";
		case "superseded":
			return "a newer proposal superseded this one";
		case "target-gone":
			return "the program is gone — nothing applied; reject the proposal to clear it";
		case "stale":
			return "the program changed since this proposal — it no longer matches what was shown; reject it and ask again";
		case "hook-unsatisfied":
			return "the hook credential wasn't generated — nothing applied";
	}
}

export interface ProgramCandidate {
	name: string;
	charter: string;
	cron: string | null;
	maxLatenessMinutes: number | null;
	hook: boolean;
	mailFilter: string | null;
}

// The complete candidate: a create's draft, or the live row merged with
// the requested patch. Approval grants this exact result, not the diff.
export function proposalCandidate(
	programs: Pick<ProgramsStore, "get">,
	proposal: ProgramProposal,
): ProgramCandidate | null {
	if (proposal.kind === "create") return proposal.draft;
	const patch = proposal.patch!;
	const target = proposal.targetId !== null ? programs.get(proposal.targetId) : null;
	if (target === null) return null;
	return {
		name: patch.name ?? target.name,
		charter: patch.charter ?? target.charter,
		cron: patch.cron !== undefined ? patch.cron : target.cron,
		maxLatenessMinutes:
			patch.maxLatenessMinutes !== undefined ? patch.maxLatenessMinutes : target.maxLatenessMinutes,
		hook: patch.hook === true ? true : target.hookHash !== null,
		mailFilter: patch.mailFilter !== undefined ? patch.mailFilter : target.mailFilter,
	};
}

export function proposalText(
	programs: Pick<ProgramsStore, "get">,
	proposal: ProgramProposal,
): string {
	const header =
		proposal.kind === "create"
			? `📋 Program proposal #${proposal.id} — new program "${proposal.draft!.name}".`
			: `📋 Program proposal #${proposal.id} — changes to program ${proposal.targetId}.`;
	const lead =
		proposal.kind === "create"
			? "Approving grants it standing authority exactly as shown:"
			: "Approving applies exactly this configuration:";
	const candidate = proposalCandidate(programs, proposal);
	if (candidate === null) {
		return [
			header,
			lead,
			"",
			"(the program is already gone — the approval will refuse; reject to clear it)",
			"",
			`requested: ${JSON.stringify(proposal.patch)}`,
		].join("\n");
	}
	return [
		header,
		lead,
		"",
		`name: ${candidate.name}`,
		"charter:",
		candidate.charter,
		"",
		`triggers: ${triggerLine(candidate)}`,
	].join("\n");
}

function triggerLine(t: ProgramCandidate): string {
	const parts: string[] = [];
	if (t.cron !== null) {
		parts.push(
			`cron "${t.cron}"${t.maxLatenessMinutes !== null ? ` (fires at most ${t.maxLatenessMinutes}m late)` : " (no lateness limit)"}`,
		);
	}
	if (t.hook) parts.push("webhook");
	if (t.mailFilter !== null) parts.push(`mail filter "${t.mailFilter}"`);
	return parts.length === 0 ? "none" : parts.join(", ");
}
