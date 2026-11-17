// The deterministic curator — design/skills.md → Self-authoring,
// /learn, curator (ruling 2026-11-16). One pass moves agent-authored
// skills between active/stale/archived on the sidecar's clock; no
// model wiring, so values read live rather than restart-pinning.
// Goblin's inactivity anchor is lastUsedAt ?? createdAt: patches do
// not reset the clock, unlike Hermes. Transitions borrowed from
// hermes-agent's agent/curator.py (apply_automatic_transitions):
//   stale 14d, archive 30d; a pass at
//   most every 168h; pinned skips; first sight seeds the clock and
//   defers; useCount === 0 never archives before the stale cutoff.
// Scope not borrowed: no LLM consolidation fork, no umbrella
// building, no view bump, no cron protection — goblin has no cron
// skills. Pin is the operator's override.
//
// Archive is a rename into workspace/skills-archive/<name> (timestamp
// suffix on collision, flattened by name) — never delete; a symlinked
// skill dir is operator state, refused, never moved. Only skills with
// a provenance row (reviewer or turn) are managed — seeded and
// operator-installed skills are never touched.
//
// One process writes the sidecar (skill-usage.ts) — no locking.

import { type Dirent, lstatSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "./home-layout.ts";
import {
	freshUsageRecord,
	readSkillUsage,
	usageAnchor,
	writeSkillUsage,
	type SkillUsageFile,
	type SkillUsageRecord,
} from "./skill-usage.ts";

export const DEFAULT_STALE_DAYS = 14;
export const DEFAULT_ARCHIVE_DAYS = 30;
export const PASS_INTERVAL_HOURS = 168;

// The config file's grammar for the curator block — the one shape
// config-schema.ts imports (one grammar, one module). Treats missing
// days as hermes' defaults.
export const curatorBlockSchema = z
	.object({
		staleDays: z.number().int().min(1).max(365).default(DEFAULT_STALE_DAYS),
		archiveDays: z.number().int().min(1).max(365).default(DEFAULT_ARCHIVE_DAYS),
	})
	.strict();
export type CuratorConfig = z.infer<typeof curatorBlockSchema>;

/** Absent = off (goblin convention; hermes defaults on). A present
 *  block parses strict and fails loud on corrupt values. */
export function curatorConfig(raw: unknown): CuratorConfig | undefined {
	if (raw === undefined) return undefined;
	return curatorBlockSchema.parse(raw);
}

export interface CuratorCounters {
	checked: number;
	seeded: number;
	markedStale: number;
	archived: number;
	reactivated: number;
	skippedPinned: number;
}

export interface CuratorStatusRow {
	skill: string;
	state: SkillUsageRecord["state"];
	pinned: boolean;
	useCount: number;
	patchCount: number;
	lastUsedAt: string | null;
	lastPatchedAt: string | null;
	/** The inactivity anchor the pass measures from. */
	anchor: string;
	/** Whole days since the anchor, floored. */
	idleDays: number;
}

/** The skills the agent wrote — distinct names with a provenance row.
 *  The store owns the query (skill-provenance.ts); the pass never
 *  invents eligibility. */
export type ManagedNames = ReadonlySet<string>;

/** True when a curator pass is due: lastCuratorRun older than
 *  PASS_INTERVAL_HOURS (null = never ran). */
export function passDue(file: SkillUsageFile, now: Date): boolean {
	if (file.lastCuratorRun === null) return true;
	return now.getTime() - Date.parse(file.lastCuratorRun) >= PASS_INTERVAL_HOURS * 3_600_000;
}

/** One deterministic pass over one sidecar read. Returns the mutated
 *  file and counters; the caller commits the write when counters
 *  moved something. Disk side effects: archive renames only. */
export function runCuratorPass(
	file: SkillUsageFile,
	managed: ManagedNames,
	cfg: CuratorConfig,
	now: Date,
): { file: SkillUsageFile; counters: CuratorCounters } {
	const counters: CuratorCounters = {
		checked: 0,
		seeded: 0,
		markedStale: 0,
		archived: 0,
		reactivated: 0,
		skippedPinned: 0,
	};
	const staleMs = cfg.staleDays * 86_400_000;
	const archiveMs = cfg.archiveDays * 86_400_000;
	for (const skill of managed) {
		const prev = file.skills[skill];
		if (prev === undefined) {
			// First sight: seed the clock, defer every transition —
			// hermes' seed_record_if_missing.
			file.skills[skill] = { ...freshUsageRecord(now), firstSeenAt: now.toISOString() };
			counters.seeded++;
			continue;
		}
		counters.checked++;
		if (prev.pinned) {
			counters.skippedPinned++;
			continue;
		}
		// Archived is terminal for the pass — only /curator restore
		// moves a skill back.
		if (prev.state === "archived") continue;
		const anchorMs = Date.parse(usageAnchor(prev));
		// useCount === 0 is absence of evidence, not staleness: never
		// archive a never-used skill before the stale cutoff.
		if (prev.useCount === 0 && anchorMs > now.getTime() - staleMs) {
			if (prev.state === "stale") {
				file.skills[skill] = { ...prev, state: "active", archivedAt: null };
				counters.reactivated++;
			}
			continue;
		}
		if (anchorMs <= now.getTime() - archiveMs) {
			if (archiveSkillDir(skill, now)) {
				file.skills[skill] = { ...prev, state: "archived", archivedAt: now.toISOString() };
				counters.archived++;
			}
		} else if (anchorMs <= now.getTime() - staleMs && prev.state === "active") {
			file.skills[skill] = { ...prev, state: "stale" };
			counters.markedStale++;
		} else if (anchorMs > now.getTime() - staleMs && prev.state === "stale") {
			// Used again after going stale — back to active.
			file.skills[skill] = { ...prev, state: "active" };
			counters.reactivated++;
		}
	}
	file.lastCuratorRun = now.toISOString();
	return { file, counters };
}

/** Move one skill dir into workspace/skills-archive — true when the
 *  dir moved or was already gone (the sidecar converges with the
 *  disk). A symlinked dir is operator state: refused, never moved,
 *  stays active. */
function archiveSkillDir(name: string, now: Date): boolean {
	const src = join(paths.skills(), name);
	let st;
	try {
		st = lstatSync(src);
	} catch (err) {
		// Already gone (a crashed pass moved the dir, an operator
		// removed it) — the sidecar converges to archived.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw err;
	}
	if (st.isSymbolicLink()) return false;
	mkdirSync(paths.skillsArchive(), { recursive: true });
	// YYYY-MM-DDTHH-MM-SS — lexicographic order is chronological, so
	// restore's newest-stamp-wins sort holds.
	const stamp = now.toISOString().slice(0, 19).replace(/[:]/g, "-");
	const dest = join(paths.skillsArchive(), `${name}.${stamp}`);
	renameSync(src, dest);
	return true;
}

// ---------- /curator and app surfaces ----------

/** Status rows for /curator status and the app skills read: every
 *  managed skill plus every record, sorted by name. Rows carry the
 *  anchor and idle days so a human can see what the pass sees. */
export function curatorStatusRows(
	file: SkillUsageFile,
	managed: ManagedNames,
	now: Date,
): CuratorStatusRow[] {
	const names = new Set<string>([...managed, ...Object.keys(file.skills)]);
	const rows: CuratorStatusRow[] = [];
	for (const skill of names) {
		const rec = file.skills[skill];
		if (rec === undefined) continue; // managed-but-unrecorded: seeded next pass
		rows.push({
			skill,
			state: rec.state,
			pinned: rec.pinned,
			useCount: rec.useCount,
			patchCount: rec.patchCount,
			lastUsedAt: rec.lastUsedAt,
			lastPatchedAt: rec.lastPatchedAt,
			anchor: usageAnchor(rec),
			idleDays: Math.floor((now.getTime() - Date.parse(usageAnchor(rec))) / 86_400_000),
		});
	}
	rows.sort((a, b) => a.skill.localeCompare(b.skill));
	return rows;
}

/** Pin or unpin one skill — the operator's override. False when the
 *  skill is neither managed nor recorded (nothing to pin). */
export function setSkillPinned(
	usagePath: string,
	skill: string,
	pinned: boolean,
	managed: ManagedNames,
	now: Date,
): boolean {
	const file = readSkillUsage(usagePath);
	const prev = file.skills[skill];
	if (prev === undefined && !managed.has(skill)) return false;
	file.skills[skill] = { ...(prev ?? freshUsageRecord(now)), pinned };
	writeSkillUsage(usagePath, file);
	return true;
}

/** Restore the newest archived copy of one skill — the bare name,
 *  else the newest stamp-suffixed duplicate. Refuses a live collision
 *  and flips the sidecar back to active (hermes' _relocate sets
 *  STATE_ACTIVE and clears archived_at) — without the flip the next
 *  pass would re-archive. Null restored = failure; reason is the
 *  operator message. */
export function restoreArchivedSkill(
	usagePath: string,
	skill: string,
): { restored: string | null; reason: string } {
	const archiveRoot = paths.skillsArchive();
	let entries: Dirent[];
	try {
		entries = readdirSync(archiveRoot, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT")
			return { restored: null, reason: "no archive yet" };
		throw err;
	}
	const candidates = entries.filter((e) => e.isDirectory()).map((e) => e.name);
	// The pass's own stamp shape only (<name>.YYYY-MM-DDTHH-MM-SS), so
	// restoring "git" can never steal "git-helpers".
	const stampRe = /^\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;
	const exact = candidates.find((n) => n === skill);
	const stamped = candidates
		.filter((n) => n.startsWith(`${skill}.`) && stampRe.test(n.slice(skill.length)))
		.sort()
		.at(-1);
	const pick = exact ?? stamped;
	if (pick === undefined) return { restored: null, reason: "not in archive" };
	const dest = join(paths.skills(), skill);
	try {
		statSync(dest);
		return { restored: null, reason: "a live skill with that name exists — discard it first" };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	renameSync(join(archiveRoot, pick), dest);
	// The record flip rides the same move.
	const file = readSkillUsage(usagePath);
	const prev = file.skills[skill];
	if (prev !== undefined) {
		file.skills[skill] = { ...prev, state: "active", archivedAt: null };
		writeSkillUsage(usagePath, file);
	}
	return { restored: skill, reason: "" };
}
