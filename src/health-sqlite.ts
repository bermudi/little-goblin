import { Database } from "bun:sqlite";
import { z } from "zod";

export const sqliteProbeSchema = z.object({
	status: z.enum(["pass", "fail"]),
	category: z.enum(["compatible", "structure", "integrity", "busy", "open-or-query"]),
});

// These are diagnostic-revision requirements, not an exact schema fingerprint.
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
		"conversation_id",
		"anchor_seq",
		"chat_id",
		"message_id",
		"rating",
		"created_at",
	],
	dm_rolls: ["chat_id", "current_id", "n"],
} as const;

function inspect(path: string): z.infer<typeof sqliteProbeSchema> {
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
		return rows.length === 1 && rows[0]?.quick_check === "ok"
			? { status: "pass", category: "compatible" }
			: { status: "fail", category: "integrity" };
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
	process.stdout.write(
		JSON.stringify(
			path.success ? inspect(path.data) : { status: "fail", category: "open-or-query" },
		),
	);
}
