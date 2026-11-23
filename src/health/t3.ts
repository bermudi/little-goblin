import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config-schema.ts";
import { after, type Timer } from "../timing.ts";
import { T3Error, makeT3, type T3Runner } from "../t3.ts";
import {
	errno,
	failure,
	ProbeError,
	result,
	type HealthResult,
	type ProbeContext,
} from "./shared.ts";

const T3_PROBE_TIMEOUT_MS = 5_000;
const UNREACHABLE_HINT =
	"Ensure T3 Code is running and the `t3` CLI is available; inspect `t3 serve`.";

// Handover targets goblin's projects only — never goblin's own workspace
// (operator, 2026-11-19, #740) — so the probe walks the active project dirs.
type ProjectDirs = { kind: "dirs"; dirs: string[] } | { kind: "none"; why: string };

function activeProjectDirs(home: string): ProjectDirs {
	const path = join(home, "state/goblin.sqlite");
	try {
		if (!statSync(path).isFile()) throw new ProbeError("not-regular-file");
	} catch (error) {
		if (errno(error) === "ENOENT") return { kind: "none", why: "No state database to read projects from" };
		throw error;
	}
	const db = new Database(path, { readonly: true, strict: true });
	try {
		db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=200");
		const table = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get();
		if (table === null) return { kind: "none", why: "No projects table yet" };
		const dirs = z
			.array(z.object({ dir: z.string() }))
			.parse(db.query("SELECT dir FROM projects WHERE archived_at IS NULL ORDER BY created_at").all())
			.map((row) => row.dir);
		return dirs.length === 0 ? { kind: "none", why: "No active project to hand over to" } : { kind: "dirs", dirs };
	} finally {
		db.close();
	}
}

export async function t3Health(
	config: Config | undefined,
	home: string,
	phase: "preflight" | "installed",
	probe: ProbeContext = {},
	runner?: T3Runner,
): Promise<HealthResult> {
	const scope = `caller-home:${home};handover`;
	if (phase === "preflight") {
		return result("delegation.t3", scope, "skip", "External service not probed before installation");
	}
	if (config === undefined) {
		return result("delegation.t3", scope, "skip", "Blocked by config");
	}

	const start = performance.now();
	let projects: ProjectDirs;
	try {
		projects = activeProjectDirs(home);
	} catch (error) {
		return failure("delegation.t3", scope, error, start, `Inspect ${join(home, "state/goblin.sqlite")}`);
	}
	if (projects.kind === "none") return result("delegation.t3", scope, "skip", projects.why, start);

	const controller = new AbortController();
	const signal = probe.signal
		? AbortSignal.any([probe.signal, controller.signal])
		: controller.signal;
	let timedOut = false;
	let timer: Timer | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = after(T3_PROBE_TIMEOUT_MS, "t3 health probe deadline", () => {
			timedOut = true;
			controller.abort(new ProbeError("deadline"));
			reject(new ProbeError("deadline"));
		});
	});

	const t3 = makeT3(runner);
	try {
		for (const dir of projects.dirs) {
			try {
				await Promise.race([t3.listThreads(dir, { signal, timeoutMs: T3_PROBE_TIMEOUT_MS }), deadline]);
				return result(
					"delegation.t3",
					scope,
					"pass",
					"T3 Code answered a read-only thread list for a goblin project",
					start,
				);
			} catch (error) {
				// T3 answered, it just doesn't know this dir: try the next project.
				if (error instanceof T3Error && error.code === "project_not_found") continue;
				throw error;
			}
		}
		return result(
			"delegation.t3",
			scope,
			"warn",
			`T3 Code answered but knows none of goblin's ${projects.dirs.length} active projects; handover has nowhere to go`,
			start,
			"Register a project you hand work over on with `t3 project add <project dir>`; never goblin's workspace.",
		);
	} catch (error) {
		const category = timedOut
			? "timeout"
			: error instanceof T3Error
				? // A runner failure wraps the spawn error: report its errno.
					error.cause !== undefined
					? errno(error.cause)
					: error.code
				: errno(error);
		return result(
			"delegation.t3",
			scope,
			"fail",
			`t3 server or CLI unreachable: ${category}`,
			start,
			UNREACHABLE_HINT,
		);
	} finally {
		if (timer !== undefined) timer.cancel();
	}
}
