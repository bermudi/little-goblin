import { relative, resolve } from "node:path";
import type { Config } from "../config-schema.ts";
import { goblinHome } from "../goblin-home.ts";
import { paths } from "../home-layout.ts";
import { T3Error, makeT3, type T3Runner } from "../t3.ts";
import {
	errno,
	ProbeError,
	result,
	type HealthResult,
	type ProbeContext,
} from "./shared.ts";

const T3_PROBE_TIMEOUT_MS = 5_000;
const UNREACHABLE_HINT =
	"Ensure T3 Code is running and the `t3` CLI is available; inspect `t3 serve`.";

function defaultWorkspace(home: string): string {
	// projectWorkdir() uses paths.workspace() for a conversation without a
	// project (src/projects.ts); rebase that home-layout path to doctor's
	// explicit target home, which may differ in tests.
	const workspaceFromHome = relative(resolve(goblinHome()), resolve(paths.workspace()));
	return resolve(home, workspaceFromHome);
}

export async function t3Health(
	config: Config | undefined,
	home: string,
	phase: "preflight" | "installed",
	probe: ProbeContext = {},
	runner?: T3Runner,
): Promise<HealthResult> {
	const scope = `caller-home:${home};handover`;
	// Handover/responsibility runs on T3 Code threads whenever goblin
	// boots — the responsibility tool mounts on project turns
	// unconditionally, so the probe gates on a readable config, not on
	// delegation being configured (delegate is back on Herdr, issue
	// #728). Preflight skips external services like the other probes.
	if (phase === "preflight") {
		return result("delegation.t3", scope, "skip", "External service not probed before installation");
	}
	if (config === undefined) {
		return result("delegation.t3", scope, "skip", "Blocked by config");
	}

	const start = performance.now();
	const workspace = defaultWorkspace(home);
	const controller = new AbortController();
	const signal = probe.signal
		? AbortSignal.any([probe.signal, controller.signal])
		: controller.signal;
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new ProbeError("deadline"));
			reject(new ProbeError("deadline"));
		}, T3_PROBE_TIMEOUT_MS);
	});

	try {
		await Promise.race([
			makeT3(runner).listThreads(workspace, {
				signal,
				timeoutMs: T3_PROBE_TIMEOUT_MS,
			}),
			deadline,
		]);
		return result(
			"delegation.t3",
			scope,
			"pass",
			"T3 Code answered a read-only thread list for the default workspace",
			start,
		);
	} catch (error) {
		if (error instanceof T3Error && error.code === "project_not_found") {
			return result(
				"delegation.t3",
				scope,
				"fail",
				"The default delegation workspace is not a T3 Code project",
				start,
				`t3 project add ${workspace}`,
			);
		}
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
		if (timer !== undefined) clearTimeout(timer);
	}
}
