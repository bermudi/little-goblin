import { Database } from "bun:sqlite";
import { z } from "zod";

export const sqliteProbeSchema = z.object({
	status: z.enum(["pass", "fail"]),
	category: z.enum(["compatible", "structure", "integrity", "busy", "open-or-query"]),
	// Boot-created subsystem tables the caller expected but found absent.
	// Absent (undefined) = the check did not run (base verdict was fail).
	missingExpected: z.array(z.string()).optional(),
});

// Diagnostic-revision requirements, not an exact schema fingerprint.
// No application store is imported: its boot path creates and migrates tables.
const required = {
	conversations: [
		"id",
		"chat_id",
		"thread_id",
		"title",
		"title_implicit",
		"cwd",
		"model",
		"thinking",
		"voice",
		"epoch",
		"created_at",
		"memory_excluded",
		"persona",
		"archived_at",
		"pinned_at",
		"project_id",
		"previous_dm_id",
	],
	events: [
		"id",
		"conversation_id",
		"seq",
		"role",
		"data",
		"anchor_seq",
		"created_at",
		"memory_eligible",
	],
	compactions: [
		"id",
		"conversation_id",
		"boundary_seq",
		"summary",
		"summary_eligible",
		"tokens_before",
		"model",
		"created_at",
	],
	prompt_snapshots: ["conversation_id", "text", "sources", "built_at"],
	reply_ratings: [
		"id",
		"channel",
		"conversation_id",
		"anchor_seq",
		"chat_id",
		"message_id",
		"event_seq",
		"rating",
		"created_at",
	],
	dm_rolls: ["chat_id", "current_id", "n"],
	dm_roll_highwater: ["chat_id", "n"],
} as const;

// Argv is a fixed vocabulary of identifiers — anything else never
// becomes SQL. A present-but-invalid list fails the probe rather than
// reporting a check that never ran.
const expectedArgSchema = z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(100);

function inspect(
	path: string,
	expectedTables: readonly string[],
): z.infer<typeof sqliteProbeSchema> {
	let db: Database | undefined;
	try {
		// A normal read-only connection sees WAL; immutable would silently miss it.
		// SQLite may maintain SHM bookkeeping, but never checkpoints this handle.
		db = new Database(path, { readonly: true, strict: true });
		db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=200");
		for (const [table, columns] of Object.entries(required)) {
			const rows = z
				.array(z.object({ name: z.string() }))
				.max(2000)
				.parse(db.query(`PRAGMA table_info(${table})`).all());
			const names = new Set(rows.map((row) => row.name));
			if (columns.some((column) => !names.has(column)))
				return { status: "fail", category: "structure" };
		}
		const rows = z
			.array(z.object({ quick_check: z.string() }))
			.max(1)
			.parse(db.query("PRAGMA quick_check(1)").all());
		if (rows.length !== 1 || rows[0]?.quick_check !== "ok")
			return { status: "fail", category: "integrity" };
		// Presence only: the caller's expected subsystem tables (fixed
		// identifiers, never row data). Table_info is the same probe the
		// required pass uses; a missing table returns zero columns.
		const handle = db;
		const missingExpected = expectedTables.filter(
			(table) => handle.query(`PRAGMA table_info(${table})`).all().length === 0,
		);
		return { status: "pass", category: "compatible", missingExpected };
	} catch (error) {
		const code = z.object({ code: z.string() }).safeParse(error);
		return {
			status: "fail",
			category:
				code.success && ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(code.data.code)
					? "busy"
					: "open-or-query",
		};
	} finally {
		db?.close();
	}
}

if (import.meta.main) {
	const path = z.string().min(1).safeParse(process.argv[2]);
	// A missing list means no expected-table check; a present one that
	// fails to parse or validate fails the probe, never a silent [].
	let expected: string[] | undefined;
	const expectedArg = process.argv[3];
	if (expectedArg === undefined) {
		expected = [];
	} else {
		try {
			expected = expectedArgSchema.parse(JSON.parse(expectedArg));
		} catch {
			expected = undefined;
		}
	}
	process.stdout.write(
		JSON.stringify(
			path.success && expected !== undefined
				? inspect(path.data, expected)
				: { status: "fail", category: "open-or-query" },
		),
	);
}
