// One-shot skill-provenance backfill (design/skills.md → Skill
// provenance): pre-table proposals predate skill_sources, and
// goblin.log's "reviewer review done" / "partially proposed" lines are
// their only surviving source — every line carries review_id,
// conversation, and the proposed skill names. Manual turn writes are
// not backfilled: the log's tool-call lines truncate args, and a
// truncated path is a guess, not provenance.
//
//   bun scripts/backfill-skill-sources.ts [logfile] [--dry]
//
// Defaults to $GOBLIN_HOME/state/goblin.log. --dry prints what would
// be recorded. Idempotent by the table's upsert (first_at survives).
// CLI, not a goblin process — stdout is the report, like
// reviewer-stats.ts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { goblinHome, paths } from "../src/config.ts";
import { openStore } from "../src/conversation.ts";
import { SkillSources } from "../src/skill-provenance.ts";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const explicit = args.find((a) => !a.startsWith("--"));
const logPath = explicit ?? join(goblinHome(), "state", "goblin.log");

if (!existsSync(logPath)) {
	process.stderr.write(`no log at ${logPath}\n`);
	process.exit(1);
}

type DoneLine = {
	msg: string;
	review_id?: unknown;
	conversation?: unknown;
	skills?: unknown;
	ts?: unknown;
};

const rows: Array<{ conversationId: string; reviewId: string; skill: string; at: string }> = [];
for (const line of readFileSync(logPath, "utf8").split("\n")) {
	if (
		!line.includes("reviewer review done") &&
		!line.includes("reviewer review partially proposed")
	)
		continue;
	let rec: DoneLine;
	try {
		rec = JSON.parse(line) as DoneLine;
	} catch {
		continue;
	}
	const conversationId = rec.conversation;
	const reviewId = rec.review_id;
	const skills = rec.skills;
	const at = rec.ts;
	if (
		typeof conversationId !== "string" ||
		typeof reviewId !== "string" ||
		!Array.isArray(skills) ||
		typeof at !== "string"
	)
		continue;
	for (const skill of skills) {
		if (typeof skill !== "string") continue;
		rows.push({ conversationId, reviewId, skill, at });
	}
}

if (rows.length === 0) {
	process.stdout.write("no proposal lines found — nothing to backfill\n");
	process.exit(0);
}

for (const row of rows) {
	process.stdout.write(
		`${dry ? "[dry] " : ""}${row.conversationId}  ${row.skill}  (review ${row.reviewId.slice(0, 8)} at ${row.at})\n`,
	);
}

if (dry) process.exit(0);

const dbPath = paths.db();
const store = openStore(dbPath);
try {
	const sources = new SkillSources(store.db);
	store.db.transaction(() => {
		for (const row of rows)
			sources.record(row.conversationId, row.skill, "reviewer", row.at, row.reviewId);
	})();
	process.stdout.write(`recorded ${rows.length} rows into ${dbPath}\n`);
} finally {
	store.close();
}
