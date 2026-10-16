// Skill provenance — which conversation generated which skill
// (design/skills.md → Skill provenance). Immutable source facts in the
// conversation store's SQLite; liveness (installed / proposed / gone)
// resolves from the filesystem at read time so the conversational
// approve/discard dir moves can never desync it.
import { type Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// A skill name per the catalog's own rule (skills.md): 1–64 chars,
// a-z0-9 and hyphens, no leading/trailing or consecutive hyphen.
export const skillNameSchema = z
	.string()
	.regex(
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
		"expected a skill name: 1-64 chars of a-z0-9 and hyphens, no leading/trailing/consecutive hyphen",
	)
	.max(64);

export const SKILL_KINDS = ["reviewer", "turn"] as const;
export type SkillSourceKind = (typeof SKILL_KINDS)[number];

const kindSchema = z.enum(SKILL_KINDS);

export interface SkillSourceRow {
	skill: string;
	conversationId: string;
	kind: SkillSourceKind;
	reviewId: string | null;
	firstAt: string;
	lastAt: string;
}

// Live state for one provenance row, resolved against the catalog at
// read time. A skill can be both proposed and installed? No — approval
// moves the dir — but a hand-copied duplicate would be; installed wins.
export type SkillLiveState = "installed" | "proposed" | "gone";

export interface SkillSourceItem extends SkillSourceRow {
	state: SkillLiveState;
}

const rowColumns = "skill, conversation_id, kind, review_id, first_at, last_at";

function rowToItem(row: {
	skill: string;
	conversation_id: string;
	kind: string;
	review_id: string | null;
	first_at: string;
	last_at: string;
}): SkillSourceRow {
	return {
		skill: row.skill,
		conversationId: row.conversation_id,
		kind: kindSchema.parse(row.kind),
		reviewId: row.review_id,
		firstAt: row.first_at,
		lastAt: row.last_at,
	};
}

export class SkillSources {
	constructor(private readonly db: Database) {
		db.run(`CREATE TABLE IF NOT EXISTS skill_sources (
			skill TEXT NOT NULL,
			conversation_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			review_id TEXT,
			first_at TEXT NOT NULL,
			last_at TEXT NOT NULL,
			PRIMARY KEY (skill, conversation_id)
		)`);
	}

	// Upsert, never overwrite pending semantics: first_at is the
	// generation moment and stays; last_at advances; a later kind
	// replaces (a reviewer proposal followed by a turn edit makes the
	// thread's latest authoring path the row's). Same-kind re-proposals
	// (the reviewer replacing its own earlier proposal) keep the first.
	record(
		conversationId: string,
		skill: string,
		kind: SkillSourceKind,
		at: string = new Date().toISOString(),
		reviewId: string | null = null,
	): void {
		const parsed = skillNameSchema.parse(skill);
		this.db.run(
			`INSERT INTO skill_sources (skill, conversation_id, kind, review_id, first_at, last_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (skill, conversation_id) DO UPDATE SET
				kind = excluded.kind,
				review_id = COALESCE(excluded.review_id, skill_sources.review_id),
				last_at = excluded.last_at`,
			[parsed, conversationId, kind, reviewId, at, at],
		);
	}

	// Rows for one conversation, newest write first — the thread panel's
	// order. Raw rows; liveness joins at the route.
	forConversation(conversationId: string): SkillSourceRow[] {
		const rows = this.db
			.query<
				{
					skill: string;
					conversation_id: string;
					kind: string;
					review_id: string | null;
					first_at: string;
					last_at: string;
				},
				[string]
			>(
				`SELECT ${rowColumns} FROM skill_sources WHERE conversation_id = ? ORDER BY last_at DESC, skill ASC`,
			)
			.all(conversationId);
		return rows.map(rowToItem);
	}

	// Backfill semantics (goblin.log parse): the row stands as the log
	// saw it ONLY when nothing newer exists — a rerun after live writes
	// must not rewind kind/last_at to log time. Insert-if-absent, and on
	// conflict take only the earlier first_at.
	recordInitial(
		conversationId: string,
		skill: string,
		at: string = new Date().toISOString(),
		reviewId: string | null = null,
	): void {
		const parsed = skillNameSchema.parse(skill);
		this.db.run(
			`INSERT INTO skill_sources (skill, conversation_id, kind, review_id, first_at, last_at)
			 VALUES (?, ?, 'reviewer', ?, ?, ?)
			 ON CONFLICT (skill, conversation_id) DO UPDATE SET
				first_at = MIN(skill_sources.first_at, excluded.first_at)`,
			[parsed, conversationId, reviewId, at, at],
		);
	}
}

export function skillLiveState(
	skillsDir: string,
	proposedDir: string,
	skill: string,
): SkillLiveState {
	if (existsSync(join(skillsDir, skill))) return "installed";
	if (existsSync(join(proposedDir, skill))) return "proposed";
	return "gone";
}
