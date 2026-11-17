// Usage telemetry for the skill catalog — the curator's clock
// (design/skills.md → Self-authoring, /learn, curator). One durable
// sidecar beside the catalog records, per skill, when it was last used
// or patched; the deterministic pass reads it to decide stale/archive.
// Record shape borrowed from hermes-agent's tools/skill_usage.py:
// keyed by skill name, never frontmatter — telemetry never touches
// SKILL.md files. One process writes it; no locking.
//
// Bump points sit at the doors and seams that observe a real use — the
// data-skill submit doors, the read_file hook, the turn-write
// attribution seam — never the resolver: a retry rebuilds the view and
// would double-count one invocation.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { durableWriteFile } from "./durable.ts";
import { skillNameSchema } from "./skill-provenance.ts";

export const USAGE_STATES = ["active", "stale", "archived"] as const;
export type SkillUsageState = (typeof USAGE_STATES)[number];

const recordSchema = z.object({
	useCount: z.number().int().min(0),
	lastUsedAt: z.iso.datetime().nullable(),
	patchCount: z.number().int().min(0),
	lastPatchedAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
	// When the curator first anchored this skill's inactivity clock
	// (seed or re-anchor); null = never seen. Hermes' firstSeenAt.
	firstSeenAt: z.iso.datetime().nullable(),
	state: z.enum(USAGE_STATES),
	pinned: z.boolean(),
	archivedAt: z.iso.datetime().nullable(),
});
export type SkillUsageRecord = z.infer<typeof recordSchema>;

const fileSchema = z.object({
	lastCuratorRun: z.iso.datetime().nullable(),
	skills: z.record(skillNameSchema, recordSchema),
});
export type SkillUsageFile = z.infer<typeof fileSchema>;

/** Goblin's inactivity anchor for stale/archive cutoffs: last use,
 *  or creation if never used. Patches do not reset the clock,
 *  unlike Hermes, which counts them as activity. */
export function usageAnchor(r: SkillUsageRecord): string {
	return r.lastUsedAt ?? r.createdAt;
}

export function freshUsageRecord(now: Date): SkillUsageRecord {
	return {
		useCount: 0,
		lastUsedAt: null,
		patchCount: 0,
		lastPatchedAt: null,
		createdAt: now.toISOString(),
		firstSeenAt: null,
		state: "active",
		pinned: false,
		archivedAt: null,
	};
}

/** Read the sidecar. Absent = empty (nothing used yet); a corrupt file
 *  fails loud — silent reset would fabricate fresh clocks and archive
 *  nothing, exactly the drift telemetry exists to prevent. */
export function readSkillUsage(path: string): SkillUsageFile {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT")
			return { lastCuratorRun: null, skills: {} };
		throw err;
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (err) {
		throw new Error(`corrupt skill usage sidecar at ${path}: not JSON`, { cause: err });
	}
	const parsed = fileSchema.safeParse(json);
	if (!parsed.success) {
		throw new Error(
			`corrupt skill usage sidecar at ${path}: ${z.prettifyError(parsed.error)}`,
		);
	}
	return parsed.data;
}

/** Whole-file durable write — the ritual every state file gets. */
export function writeSkillUsage(path: string, file: SkillUsageFile): void {
	durableWriteFile(path, `${JSON.stringify(file, null, "\t")}\n`);
}

/**
 * Record one use (explicit invocation or the agent reading the
 * SKILL.md). A skill with no record starts one — telemetry covers the
 * whole catalog; curation eligibility is the curator's question,
 * decided from provenance rows, not from having a record.
 */
export function noteSkillUse(path: string, skill: string, now: Date): void {
	const file = readSkillUsage(path);
	const prev = file.skills[skill] ?? freshUsageRecord(now);
	file.skills[skill] = {
		...prev,
		useCount: prev.useCount + 1,
		lastUsedAt: now.toISOString(),
	};
	writeSkillUsage(path, file);
}

/**
 * Record one write — the turn-write attribution seam's bump. A draft
 * write under skills-proposed/ counts too: the name's engagement is
 * real, and the record survives the install that promotes the draft.
 */
export function noteSkillPatch(path: string, skill: string, now: Date): void {
	const file = readSkillUsage(path);
	const prev = file.skills[skill] ?? freshUsageRecord(now);
	file.skills[skill] = {
		...prev,
		patchCount: prev.patchCount + 1,
		lastPatchedAt: now.toISOString(),
	};
	writeSkillUsage(path, file);
}
