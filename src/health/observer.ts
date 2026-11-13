// The responsibility observer's durable outage declarations: an
// attachment whose target failed UNREACHABLE_POLLS consecutive polls
// keeps unreachable_since until a reconcile succeeds. Read-only — the
// same read-only Database handle the sqlite probe uses, in-process
// because the worker boundary already bounds it.
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { UNREACHABLE_POLLS } from "../responsibility-types.ts";
import {
	errno,
	failure,
	ProbeError,
	result,
	type HealthReport,
	type HealthResult,
} from "./shared.ts";

const unreachableRow = z.object({
	agent_name: z.string(),
	server: z.string(),
	session: z.string(),
	unreachable_since: z.string(),
});

export function observer(home: string, phase: HealthReport["phase"]): HealthResult[] {
	const start = performance.now();
	const scope = `caller-home:${home}`;
	const path = join(home, "state/goblin.sqlite");
	try {
		if (!statSync(path).isFile()) throw new ProbeError("not-regular-file");
	} catch (error) {
		if (errno(error) === "ENOENT" || phase === "preflight")
			return [
				result(
					"observer.unreachable",
					scope,
					"skip",
					phase === "preflight"
						? "First-boot database not yet required"
						: "No state database to inspect",
					start,
				),
			];
		return [failure("observer.unreachable", scope, error, start, `Stat ${path}`)];
	}
	let db: Database;
	try {
		db = new Database(path, { readonly: true, strict: true });
		db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=200");
	} catch (error) {
		return [failure("observer.unreachable", scope, error, start, `Open ${path}`)];
	}
	try {
		const columns = z
			.array(z.object({ name: z.string() }))
			.parse(db.query("PRAGMA table_info(attachments)").all())
			.map((c) => c.name);
		if (!columns.includes("unreachable_since"))
			return [
				result(
					"observer.unreachable",
					scope,
					"skip",
					"Store predates the observation-availability columns — next boot migrates it",
					start,
				),
			];
		const rows = unreachableRow.array().max(1000).parse(
			db
				.query(
					`SELECT agent_name, server, session, unreachable_since FROM attachments
						WHERE unreachable_count >= ${UNREACHABLE_POLLS} AND unreachable_since IS NOT NULL`,
				)
				.all(),
		);
		if (rows.length === 0)
			return [
				result("observer.unreachable", scope, "pass", "No observed outage is declared", start),
			];
		const named = rows
			.map((r) => `${r.agent_name} on ${r.server}/${r.session} since ${r.unreachable_since}`)
			.join("; ");
		return [
			result(
				"observer.unreachable",
				scope,
				"warn",
				`${rows.length === 1 ? "An attachment is" : `${rows.length} attachments are`} declared observation-unreachable: ${named}`,
				start,
			),
		];
	} catch (error) {
		// A corrupt or locked store is a fail with the operation named —
		// never a crash out of the collector, never a false pass.
		return [failure("observer.unreachable", scope, error, start, `Read ${path}`)];
	} finally {
		db.close();
	}
}
