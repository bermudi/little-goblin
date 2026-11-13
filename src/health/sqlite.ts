import { statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config-schema.ts";
import { sqliteProbeSchema } from "../health-sqlite.ts";
import {
	command,
	failure,
	ProbeError,
	result,
	type HealthReport,
	type HealthResult,
	type ProbeContext,
} from "./shared.ts";

// Feature tables join the expectation only while their config block
// exists — delegations needs `delegation`, memory_outage needs
// `memory`, and the telegram channel tables need the boot-pinned
// `telegram.enabled` (startBot, which creates them, is gated on it).
// Lazy tables (forget_listings, tg_dm_navigation*) are deliberately
// absent: they appear on first use, not at boot.
function expectedTables(config: Config | undefined): string[] {
	const boot = [
		"projects",
		"notes",
		"note_versions",
		"notes_fts",
		"events_fts",
		"memory_outbox",
		"memory_blocked_notices",
		"memory_contexts",
		"memory_suppressions",
		"memory_destinations",
		"programs",
		"program_proposals",
		"mail_outbox",
		"sandboxes",
		"tg_pings",
		"model_cache_calls",
		"event_projections",
		"app_push_subscriptions",
		"app_push_deliveries",
		"turn_runs",
		"turn_tool_calls",
		"context_windows",
		"context_window_state",
	];
	if (config?.telegram.enabled) boot.push("tg_inbox", "tg_inbox_archives", "guest_dedup");
	if (config?.delegation !== undefined) boot.push("delegations");
	if (config?.memory !== undefined) boot.push("memory_outage");
	return boot;
}

export async function sqlite(
	home: string,
	phase: HealthReport["phase"],
	probe: ProbeContext = {},
	config?: Config,
): Promise<HealthResult[]> {
	const start = performance.now(),
		scope = `caller-home:${home};diagnostic-revision`,
		id = "sqlite";
	if (phase === "preflight")
		return [
			result(
				id,
				scope,
				"skip",
				"Database and additive schema initialized at first boot; not required preflight",
				start,
			),
			result("sqlite.subsystems", scope, "skip", "Blocked by sqlite", start),
		];
	try {
		const path = join(home, "state/goblin.sqlite");
		if (!statSync(path).isFile()) throw new ProbeError("not-regular-file");
		const raw = await command(
			[
				process.execPath,
				"--no-install",
				join(import.meta.dir, "..", "health-sqlite.ts"),
				path,
				JSON.stringify(expectedTables(config)),
			],
			5000,
			probe,
		);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new ProbeError("invalid-worker-JSON");
		}
		const report = sqliteProbeSchema.safeParse(parsed);
		if (!report.success) throw new ProbeError("invalid-worker-schema");
		const base = result(
			id,
			scope,
			report.data.status,
			report.data.category === "compatible"
				? "Read-only WAL-aware quick_check and required base structure compatible with diagnostic revision; installed revision unverified; SHM bookkeeping permitted"
				: `Diagnostic-revision compatibility/integrity: ${report.data.category}; not a claim of installed-schema corruption`,
			start,
		);
		if (report.data.status !== "pass")
			return [base, result("sqlite.subsystems", scope, "skip", "Blocked by sqlite", start)];
		const missing = report.data.missingExpected ?? [];
		return [
			base,
			result(
				"sqlite.subsystems",
				scope,
				missing.length ? "warn" : "pass",
				missing.length
					? `Boot-created subsystem tables absent under this diagnostic revision's expectations: ${missing.join(", ")} — the expected list tracks the diagnostic revision, so a store predating it is the ordinary explanation; next boot creates them. Absence alone is not evidence of corruption or store loss`
					: "All expected subsystem tables present; row contents unverified",
				start,
			),
		];
	} catch (error) {
		return [
			failure(id, scope, error, start, "Read-only SQLite worker"),
			result("sqlite.subsystems", scope, "skip", "Blocked by sqlite", start),
		];
	}
}
