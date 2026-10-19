// Disk is the state — no rows, nothing pending a restart; a decision on
// a gone proposal reports "already gone". Install swaps a live copy
// atomically with rollback; discard deletes the staged dir. The
// resolution history event is the durable correction to the reviewer's
// "parked, not installed" claim.

import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { log } from "./log.ts";
import { stagingRoot } from "./reviewer.ts";
import type { SkillSourceRow } from "./skill-provenance.ts";

export type SkillAction = "install" | "discard";

export type SkillDecision =
	| { action: "install"; ok: true; replaced: boolean }
	| { action: "discard"; ok: true }
	| { action: SkillAction; ok: false; reason: string };

export interface SkillDecisionDeps {
	workspaceDir: string;
	skillsDir: string;
	proposedDir: string;
	/** Test door for the swap-trash timestamp. */
	now?(): Date;
	// Both optional: a pre-table proposal has no provenance row, and a
	// decision still lands when there's no thread to correct.
	forSkill?(skill: string): SkillSourceRow[];
	store?: { append(id: string, messages: UIMessage[]): void };
}

// lstat, never stat: a symlink parked on either path is operator state —
// never clobbered, never followed (same rule as the reviewer's swaps).
function installProposal(
	deps: Pick<SkillDecisionDeps, "skillsDir" | "proposedDir" | "workspaceDir" | "now">,
	skill: string,
): { ok: true; replaced: boolean } | { ok: false; reason: string } {
	const proposed = join(deps.proposedDir, skill);
	const target = join(deps.skillsDir, skill);
	let proposedStats;
	try {
		proposedStats = lstatSync(proposed);
	} catch (err) {
		// Only absence is "gone" — permission or I/O failures are real
		// filesystem state and must surface, not be reported as gone.
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		return { ok: false, reason: "gone" };
	}
	if (proposedStats.isSymbolicLink()) return { ok: false, reason: "proposal dir is a symlink" };
	let targetStats;
	try {
		targetStats = lstatSync(target);
	} catch (err) {
		// Live copy not there at all — plain move. Anything but ENOENT
		// (an unreadable skills dir) is not "not there" — propagate.
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (targetStats?.isSymbolicLink()) return { ok: false, reason: "live skill is a symlink" };
	mkdirSync(deps.skillsDir, { recursive: true });
	if (targetStats === undefined) {
		renameSync(proposed, target);
		return { ok: true, replaced: false };
	}
	const staging = stagingRoot(deps.workspaceDir);
	mkdirSync(staging, { recursive: true });
	const trash = join(
		staging,
		`.replaced-approve-${(deps.now?.() ?? new Date()).getTime()}-${skill}`,
	);
	rmSync(trash, { recursive: true, force: true });
	renameSync(target, trash);
	try {
		renameSync(proposed, target);
	} catch (err) {
		// Rollback must not mask the original failure — a second throw
		// strands the live copy in staging (cleanupStaging keeps
		// .replaced-* entries precisely so this is recoverable).
		try {
			renameSync(trash, target);
		} catch (rbErr) {
			log.error("skill approve rollback failed — live copy stranded in staging", rbErr, {
				skill,
				trash,
				target,
			});
		}
		throw err;
	}
	try {
		rmSync(trash, { recursive: true, force: true });
	} catch (err) {
		// The swap succeeded: cleanup is not a decision failure.
		log.warn("skill approve replaced-copy cleanup failed", err, { skill, trash });
	}
	return { ok: true, replaced: true };
}

function discardProposal(
	deps: Pick<SkillDecisionDeps, "proposedDir">,
	skill: string,
): { ok: true } | { ok: false; reason: string } {
	const proposed = join(deps.proposedDir, skill);
	let stats;
	try {
		stats = lstatSync(proposed);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		return { ok: false, reason: "gone" };
	}
	if (stats.isSymbolicLink()) return { ok: false, reason: "proposal dir is a symlink" };
	// The ruling defines discard as deletion; a proposal is a
	// regenerable reviewer artifact, never operator-authored work.
	rmSync(proposed, { recursive: true, force: true });
	return { ok: true };
}

// logFields carries the door's context (conversation, actor) onto the
// line. Failures log too: "gone" is informational, anything else is a
// conflict worth a warn.
export function decideSkillProposal(
	deps: SkillDecisionDeps,
	skill: string,
	action: SkillAction,
	logFields: Record<string, unknown> = {},
): SkillDecision {
	if (action === "install") {
		const outcome = installProposal(deps, skill);
		if (outcome.ok) {
			log.info("skill proposal installed", { skill, replaced: outcome.replaced, ...logFields });
		} else if (outcome.reason === "gone") {
			log.info("skill proposal decision — proposal gone", { skill, action, ...logFields });
		} else {
			log.warn("skill proposal install conflict", {
				skill,
				reason: outcome.reason,
				...logFields,
			});
		}
		return { action, ...outcome };
	}
	const outcome = discardProposal(deps, skill);
	if (outcome.ok) {
		log.info("skill proposal discarded", { skill, ...logFields });
	} else if (outcome.reason === "gone") {
		log.info("skill proposal decision — proposal gone", { skill, action, ...logFields });
	} else {
		log.warn("skill proposal discard conflict", {
			skill,
			reason: outcome.reason,
			...logFields,
		});
	}
	return { action, ...outcome };
}

// Matches the "skill proposal resolved: <name> — …" form reviewer events
// use.
export function skillResolutionText(
	decision: Extract<SkillDecision, { ok: true }>,
	skill: string,
): string {
	return decision.action === "install"
		? `skill proposal resolved: ${skill} — installed${decision.replaced ? " (replaced live copy)" : ""}`
		: `skill proposal resolved: ${skill} — discarded (deleted)`;
}

// Append failures never un-decide — the log line already carries the
// decision.
export function appendSkillResolution(
	store: { append(id: string, messages: UIMessage[]): void },
	conversationId: string,
	text: string,
): void {
	try {
		store.append(conversationId, [
			{ id: randomUUID(), role: "system", parts: [{ type: "text", text }] },
		]);
	} catch (err) {
		log.warn("skill resolution history append failed", err, {
			conversation: conversationId,
		});
	}
}

// A skill with no provenance row — proposals from before the table
// existed — still decides; history just has nothing to correct.
export function resolveSkillProposal(
	deps: SkillDecisionDeps,
	skill: string,
	action: SkillAction,
): SkillDecision {
	const conversationId = deps.forSkill?.(skill)[0]?.conversationId ?? null;
	const decision = decideSkillProposal(
		deps,
		skill,
		action,
		conversationId === null ? {} : { conversation: conversationId },
	);
	if (decision.ok && conversationId !== null && deps.store !== undefined) {
		appendSkillResolution(deps.store, conversationId, skillResolutionText(decision, skill));
	}
	return decision;
}
