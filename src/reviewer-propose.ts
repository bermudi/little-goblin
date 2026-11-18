// Proposal mechanics — drift detection against the live tree and the
// atomic swap into skills-proposed/. Nothing installs: the live catalog
// changes only on operator approval (ruling 2026-10-10). Depends on the
// staging module's sha256 (shared manifest hashing); reviewer.ts is the
// only caller.

import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	type Stats,
} from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";
import { sha256, type DraftManifest } from "./reviewer-staging.ts";

export type ProposeOutcome =
	| { proposed: true }
	| { proposed: false; reason: "conflict" | "draft-changed"; drifted: string[] };

// A proposal built on a base the operator changed mid-review must never
// be offered — approving it would clobber those bytes sight-unseen, so
// the skill is skipped. Symlinks count as drift too (lstat, never
// resolved): an approved proposal over a link would replace it with
// plain bytes and silently fork whatever it points to.
function liveDrifted(skillsDir: string, manifest: Map<string, string>, skill: string): string[] {
	const prefix = `${skill}/`;
	const expected = new Map([...manifest.entries()].filter(([rel]) => rel.startsWith(prefix)));
	const drifted: string[] = [];
	const liveSkill = join(skillsDir, skill);
	// lstat, not existsSync: a broken link is still a link and must
	// conflict like any other, not count as "not there". Only ENOENT is
	// "not there" — an unreadable root (EACCES, ELOOP, EIO) is a real
	// failure, not a brand-new skill.
	let rootStats: Stats | undefined;
	try {
		rootStats = lstatSync(liveSkill);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (rootStats === undefined) {
		// Not in the manifest either → brand-new skill, nothing to drift.
		if (expected.size === 0) return [];
		return [...expected.keys()];
	}
	if (rootStats.isSymbolicLink()) return [skill];
	const walk = (rel: string): void => {
		const abs = rel === "." ? liveSkill : join(liveSkill, rel);
		for (const dirent of readdirSync(abs, { withFileTypes: true })) {
			const child = rel === "." ? dirent.name : `${rel}/${dirent.name}`;
			const childRel = `${skill}/${child}`;
			// lstat: a link never resolves into the byte comparison —
			// even one whose content matches must not be proposed over.
			const stats = lstatSync(join(liveSkill, child));
			if (stats.isSymbolicLink()) {
				drifted.push(childRel);
				expected.delete(childRel);
			} else if (stats.isDirectory()) {
				walk(child);
			} else if (stats.isFile()) {
				const prev = expected.get(childRel);
				if (prev === undefined || sha256(readFileSync(join(liveSkill, child))) !== prev) {
					drifted.push(childRel);
				}
				expected.delete(childRel);
			}
		}
	};
	walk(".");
	// Files the operator deleted mid-review also drift the tree.
	drifted.push(...expected.keys());
	return drifted.sort();
}

function pendingDraftDrifted(
	proposedDir: string,
	drafts: DraftManifest,
	skill: string,
): string[] {
	let proposedStats: Stats;
	try {
		proposedStats = lstatSync(proposedDir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	// proposeSkill owns validation of an invalid root. Do not follow a
	// root symlink while checking whether a draft changed.
	if (!proposedStats.isDirectory() || proposedStats.isSymbolicLink()) return [];
	const prefix = `${skill}/`;
	const expected = new Map([...drafts.files].filter(([rel]) => rel.startsWith(prefix)));
	let rootStats: Stats | undefined;
	try {
		rootStats = lstatSync(join(proposedDir, skill));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (rootStats === undefined) return [...expected.keys()].length > 0 || drafts.skills.has(skill) ? [skill] : [];
	if (rootStats.isSymbolicLink()) return drafts.skills.has(skill) ? [skill] : [];
	if (!rootStats.isDirectory()) return drafts.skills.has(skill) ? [skill] : [];
	const drifted: string[] = [];
	const walk = (rel: string): void => {
		const abs = rel === "." ? join(proposedDir, skill) : join(proposedDir, skill, rel);
		for (const entry of readdirSync(abs, { withFileTypes: true })) {
			const child = rel === "." ? entry.name : `${rel}/${entry.name}`;
			const childRel = `${prefix}${child}`;
			const childAbs = join(proposedDir, skill, child);
			const stats = lstatSync(childAbs);
			if (stats.isSymbolicLink()) {
				drifted.push(childRel);
				expected.delete(childRel);
			} else if (stats.isDirectory()) {
				walk(child);
			} else if (stats.isFile()) {
				const prev = expected.get(childRel);
				if (prev === undefined || sha256(readFileSync(childAbs)) !== prev) drifted.push(childRel);
				expected.delete(childRel);
			}
		}
	};
	walk(".");
	drifted.push(...expected.keys());
	if (!drafts.skills.has(skill)) drifted.unshift(skill);
	return [...new Set(drifted)].sort();
}

// Atomic directory swap into the proposals dir: earlier undecided
// draft → .replaced-* trash (same filesystem), staged → proposal,
// trash deleted. The reviewer stages and edits an existing draft; drafts
// changed during the review are left untouched. Throws on swap failures
// (after rollback); drift against either baseline is returned, not thrown.
export function proposeSkill(
	skillsDir: string,
	proposedDir: string,
	stagedDir: string,
	stagingArea: string,
	manifest: Map<string, string>,
	drafts: DraftManifest,
	skill: string,
	reviewId: string,
): ProposeOutcome {
	const drifted = liveDrifted(skillsDir, manifest, skill);
	if (drifted.length > 0) return { proposed: false, reason: "conflict", drifted };
	let rootStats: Stats | undefined;
	try {
		rootStats = lstatSync(proposedDir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (rootStats === undefined) {
		mkdirSync(proposedDir, { recursive: true });
		rootStats = lstatSync(proposedDir);
	}
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
		throw new Error(
			`reviewer proposals dir ${proposedDir} is ${rootStats.isSymbolicLink() ? "a symlink" : "not a directory"} — refusing to park proposals`,
		);
	}
	const draftDrifted = pendingDraftDrifted(proposedDir, drafts, skill);
	if (draftDrifted.length > 0) {
		log.warn("reviewer proposal skipped — pending draft changed mid-review", {
			skill,
			review_id: reviewId,
			reason: "draft-changed",
			drifted: draftDrifted,
		});
		return { proposed: false, reason: "draft-changed", drifted: draftDrifted };
	}
	const target = join(proposedDir, skill);
	// lstat, not existsSync: a symlink parked on the target name is
	// operator state, not an earlier proposal — never trashed, and a
	// broken link must conflict too, not read as "not there".
	let targetStats: Stats | undefined;
	try {
		targetStats = lstatSync(target);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (targetStats?.isSymbolicLink()) {
		log.warn("reviewer proposal skipped — proposal target is a symlink", {
			skill,
			review_id: reviewId,
		});
		return { proposed: false, reason: "conflict", drifted: [skill] };
	}
	const existed = targetStats !== undefined;
	const trash = join(stagingArea, `.replaced-${reviewId}-${skill}`);
	rmSync(trash, { recursive: true, force: true });
	if (existed) {
		renameSync(target, trash);
		log.info("reviewer proposal revised a pending draft", {
			skill,
			review_id: reviewId,
		});
	}
	try {
		renameSync(join(stagedDir, skill), target);
	} catch (err) {
		if (existed) {
			// The rollback is its own operation — a throw here must not
			// mask the swap's error; the displaced proposal stays under
			// .replaced-*, which cleanupStaging preserves.
			try {
				renameSync(trash, target);
			} catch (rbErr) {
				log.error("reviewer proposal rollback failed — earlier proposal stranded", rbErr, {
					skill,
					review_id: reviewId,
					trash,
				});
			}
		}
		throw err;
	}
	try {
		rmSync(trash, { recursive: true, force: true });
	} catch (err) {
		// The swap succeeded: cleanup is not a proposal failure. The
		// next boot cleans reviewer staging; keep the proposal recorded.
		log.warn("reviewer replaced-proposal trash cleanup failed", err, {
			skill,
			review_id: reviewId,
			trash,
		});
	}
	return { proposed: true };
}
