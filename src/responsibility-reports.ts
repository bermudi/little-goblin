// Structured reports on a responsibility — the work's state as
// stated, never inferred from prose (design/programs.md → Reports and
// stages; borrowed from dsh-superagent's Report). Append-only: the
// latest report at the current revision feeds the derived stage, and
// history stays inspectable. Who stated it is recorded — a worker's
// claim and goblin's assessment must stay distinguishable.

import type { Database } from "bun:sqlite";
import { z } from "zod";

export const REPORT_STATES = [
	"progress",
	"waiting",
	"ready",
	"blocked",
	"failed",
	"done",
	"dropped",
] as const;
export type ReportState = (typeof REPORT_STATES)[number];

/** Terminal reports close the responsibility in the same transaction. */
export const TERMINAL_REPORTS: ReadonlySet<ReportState> = new Set(["done", "dropped"]);

/** goblin = the coordinating turn's assessment; worker = a run's own
 *  claim (reserved for pi-durable runs); migration = a legacy status. */
export type ReportReporter = "goblin" | "worker" | "migration";

const text = (max: number) => z.string().trim().min(1).max(max);

export const reportEvidenceSchema = z.strictObject({
	/** The understanding's completionEvidence entry this covers, verbatim. */
	item: text(2000),
	/** Where the evidence lives — a path, URL, command, or event. */
	ref: text(2000),
	/** What was actually inspected or run, and what it showed. */
	checked: text(2000),
});
export type ReportEvidence = z.infer<typeof reportEvidenceSchema>;

export const reportInputSchema = z
	.strictObject({
		state: z.enum(REPORT_STATES),
		reason: text(4000),
		/** One concrete question for the operator — the stage waits on them. */
		question: text(2000).optional(),
		/** The external condition a `waiting` report resumes on. */
		resumeWhen: text(2000).optional(),
		evidence: z.array(reportEvidenceSchema).max(32).optional(),
	})
	.superRefine((v, ctx) => {
		if (v.state === "waiting" && v.resumeWhen === undefined)
			ctx.addIssue({ code: "custom", path: ["resumeWhen"], message: "waiting needs resumeWhen" });
		if (v.state === "done" && (v.evidence?.length ?? 0) === 0)
			ctx.addIssue({ code: "custom", path: ["evidence"], message: "done needs evidence" });
		if (TERMINAL_REPORTS.has(v.state) && v.question !== undefined)
			ctx.addIssue({
				code: "custom",
				path: ["question"],
				message: "a closing report cannot ask a question — report blocked or ready instead",
			});
	});
export type ReportInput = z.infer<typeof reportInputSchema>;

export interface ResponsibilityReport {
	reportId: number;
	responsibilityId: string;
	/** The responsibility revision it was stated against — an operator
	 *  correction (which bumps revision) answers anything it asked. */
	revision: number;
	reporter: ReportReporter;
	state: ReportState;
	reason: string;
	question: string | null;
	resumeWhen: string | null;
	evidence: ReportEvidence[];
	/** Stable identity of an external settlement (a run's outcome) — a
	 *  retried notice files it once. Null for goblin's own reports. */
	sourceKey: string | null;
	createdAt: string;
}

const rowSchema = z.object({
	report_id: z.number(),
	responsibility_id: z.string(),
	revision: z.number(),
	reporter: z.enum(["goblin", "worker", "migration"]),
	state: z.enum(REPORT_STATES),
	reason: z.string(),
	question: z.string().nullable(),
	resume_when: z.string().nullable(),
	evidence_json: z.string(),
	source_key: z.string().nullable(),
	created_at: z.string(),
});

export function toReport(row: unknown): ResponsibilityReport {
	const r = rowSchema.parse(row);
	return {
		reportId: r.report_id,
		responsibilityId: r.responsibility_id,
		revision: r.revision,
		reporter: r.reporter,
		state: r.state,
		reason: r.reason,
		question: r.question,
		resumeWhen: r.resume_when,
		evidence: z.array(reportEvidenceSchema).parse(JSON.parse(r.evidence_json)),
		sourceKey: r.source_key,
		createdAt: r.created_at,
	};
}

export function ensureReportsSchema(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS responsibility_reports (
			report_id INTEGER PRIMARY KEY AUTOINCREMENT,
			responsibility_id TEXT NOT NULL REFERENCES responsibilities(responsibility_id),
			revision INTEGER NOT NULL,
			reporter TEXT NOT NULL CHECK (reporter IN ('goblin','worker','migration')),
			state TEXT NOT NULL CHECK (state IN ('progress','waiting','ready','blocked','failed','done','dropped')),
			reason TEXT NOT NULL,
			question TEXT,
			resume_when TEXT,
			evidence_json TEXT NOT NULL,
			source_key TEXT,
			created_at TEXT NOT NULL
		)`);
	const cols = new Set(
		(db.query("PRAGMA table_info(responsibility_reports)").all() as { name: string }[]).map(
			(c) => c.name,
		),
	);
	if (!cols.has("source_key")) db.run("ALTER TABLE responsibility_reports ADD COLUMN source_key TEXT");
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS responsibility_reports_source ON responsibility_reports (source_key) WHERE source_key IS NOT NULL",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS responsibility_reports_resp ON responsibility_reports (responsibility_id, report_id)",
	);
}

/** completionEvidence entries no evidence item covers. Matching is by
 *  the entry's text (trimmed) — the reporter names what it verified,
 *  item by item, rather than asserting "all good". */
export function missingEvidence(
	required: readonly string[],
	evidence: readonly ReportEvidence[],
): string[] {
	const covered = new Set(evidence.map((e) => e.item.trim()));
	return required.filter((r) => !covered.has(r.trim()));
}
