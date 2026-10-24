// Channel-neutral owner for the program grant boundary. A transport
// posts the immutable candidate and renders controls; this owner is the
// only path that mints grant-time hook credentials and asks the store
// to decide. The hook URL is returned to the authenticated surface
// that requested approval — it never enters model context or history.

import { hookTokenHash, hookUrl, newHookToken } from "./program-hook.ts";
import { log } from "./log.ts";
import {
	programFingerprint,
	snapshotProgram,
	type ProgramProposal,
	type ProposalRefusal,
} from "./program-proposals.ts";
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
	/** Posts the complete immutable candidate to the proposal's target.
	 *  The staging turn's abort signal fences chunked posting; a present
	 *  that cannot honor it still returns normally or throws. */
	present(proposal: ProgramProposal, signal?: AbortSignal): Promise<void>;
	now?(): Date;
}

export interface ProgramApproval {
	requestApproval(proposal: ProgramProposal, signal?: AbortSignal): Promise<void>;
	decide(
		id: number,
		action: ProgramDecision,
		actor: DecisionActor,
	): Promise<ProgramDecisionOutcome>;
	pending(): ProgramProposal[];
	candidate(proposal: ProgramProposal): ProgramCandidate | null;
	/** Joins in-flight requestApproval posts — shutdown's drain budget
	 *  bounds the wait. */
	stop(): Promise<void>;
}

export function startProgramApproval(deps: ProgramApprovalDeps): ProgramApproval {
	// In-flight posts; stop() joins them (mail-approval's pattern). The
	// staging turn's signal fences the posting itself — the join only
	// bounds the await, never replaces the fencing.
	const inFlight = new Set<Promise<void>>();
	return {
		async requestApproval(proposal, signal) {
			const p = deps.present(proposal, signal);
			inFlight.add(p);
			void p.catch(() => {}).then(() => inFlight.delete(p));
			await p;
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
		async stop() {
			const waits = [...inFlight];
			if (waits.length > 0) {
				log.info("program approval — joining in-flight posts on shutdown", {
					posts: waits.length,
				});
			}
			await Promise.allSettled(waits);
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

// The complete candidate: a create's draft, or the patch merged onto the
// base the operator was shown. Update renders come from the immutable
// snapshot staged with the proposal, so a re-post after the live program
// moved shows exactly what the original card showed — never a merge onto
// today's row that approval would then bind to the old base. Legacy rows
// predate the snapshot column; their only honest render is the live row
// itself, and that is exactly the base while the fingerprint matches.
// Once it drifts there is nothing immutable left to show — null, not a
// guess. Approval grants this exact result, not the diff.
export function proposalCandidate(
	programs: Pick<ProgramsStore, "get">,
	proposal: ProgramProposal,
): ProgramCandidate | null {
	if (proposal.kind === "create") return proposal.draft;
	const patch = proposal.patch!;
	const target = proposal.targetId !== null ? programs.get(proposal.targetId) : null;
	if (target === null) return null;
	if (proposal.baseSnapshot === null && programFingerprint(target) !== proposal.base) {
		return null;
	}
	const base = proposal.baseSnapshot ?? snapshotProgram(target);
	return {
		name: patch.name ?? base.name,
		charter: patch.charter ?? base.charter,
		cron: patch.cron !== undefined ? patch.cron : base.cron,
		maxLatenessMinutes:
			patch.maxLatenessMinutes !== undefined ? patch.maxLatenessMinutes : base.maxLatenessMinutes,
		hook: patch.hook === true ? true : base.hook,
		mailFilter: patch.mailFilter !== undefined ? patch.mailFilter : base.mailFilter,
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
	if (proposal.kind === "create") {
		const candidate = proposalCandidate(programs, proposal)!;
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
	const patch = proposal.patch!;
	const target = proposal.targetId !== null ? programs.get(proposal.targetId) : null;
	if (target === null) {
		return [
			header,
			lead,
			"",
			"(the program is already gone — the approval will refuse; reject to clear it)",
			"",
			`requested: ${JSON.stringify(patch)}`,
		].join("\n");
	}
	const stale = programFingerprint(target) !== proposal.base;
	const candidate = proposalCandidate(programs, proposal);
	if (stale && candidate === null) {
		// A drifted legacy row has nothing immutable left to show — name
		// the coming refusal instead of guessing a merge.
		return [
			header,
			lead,
			"",
			"(the program changed since this proposal — approving will refuse as stale; reject it and ask again)",
			"",
			`requested: ${JSON.stringify(patch)}`,
		].join("\n");
	}
	return [
		header,
		lead,
		...(stale
			? [
					"",
					"(the program changed since this proposal was staged — approving will refuse as stale; reject it and ask again)",
				]
			: []),
		"",
		`name: ${candidate!.name}`,
		"charter:",
		candidate!.charter,
		"",
		`triggers: ${triggerLine(candidate!)}`,
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
