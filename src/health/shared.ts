import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	statfsSync,
} from "node:fs";
import { z } from "zod";
import { boundedRun, killProc, spawnProc, type ProcessGroupMode } from "../proc.ts";

export const healthResultSchema = z.object({
	id: z.string(),
	status: z.enum(["pass", "warn", "fail", "skip"]),
	scope: z.string(),
	detail: z.string(),
	durationMs: z.number().finite().nonnegative(),
	next: z.string().optional(),
});
export type HealthResult = z.infer<typeof healthResultSchema>;
export const healthReportSchema = z.object({
	version: z.literal(1),
	checkedAt: z.iso.datetime(),
	phase: z.enum(["preflight", "installed"]),
	target: z.object({ home: z.string(), checkout: z.string() }),
	results: z.array(healthResultSchema),
});
export type HealthReport = z.infer<typeof healthReportSchema>;

export type ProbeContext = { signal?: AbortSignal; processGroup?: ProcessGroupMode };

export class ProbeError extends Error {
	constructor(readonly category: string) {
		super(category);
	}
}
export function errno(error: unknown): string {
	const parsed = z.object({ code: z.string().regex(/^E[A-Z0-9]+$/) }).safeParse(error);
	return error instanceof ProbeError
		? error.category
		: parsed.success
			? parsed.data.code
			: "inspection-error";
}
const manualHints: Readonly<Record<string, string>> = {
	"auth.coverage":
		"Verify upstream credentials, OAuth and boot-cached values through ordinary authorized use without printing values; doctor does not resolve them.",
	config:
		"Inspect local config syntax and references; do not print credentials or make provider calls.",
	auth: "Inspect local auth permissions and the reported record line without printing values; credential edits are operator-owned.",
	keys: "Inspect pass-keys status and refresh diagnostics without values; wallet unlock and key provisioning are operator-owned.",
	workspace:
		"Inspect the caller-home layout and permissions locally; provision missing files manually under the approved setup runbook.",
	storage:
		"Inspect free space and inodes on the reported filesystem; review backups before manual cleanup.",
	sqlite:
		"Check the matching revision and backups before manual database inspection; do not checkpoint or migrate during diagnosis.",
	service:
		"Inspect user-unit status and checkout identity; do not restart without operator approval.",
	installation:
		"Compare diagnostic and installed revisions and launcher targets manually; no automatic restart or deployment.",
	app: "Build and publish the client only as a coordinated, approved backend rollout; do not overwrite live assets to test.",
	"memory.embedding":
		"Inspect relay and Ollama readiness and model identity; do not change a populated bank's embedding model.",
	memory:
		"Inspect memory readiness and local installation metadata under the approved runbook; do not print credentials or alter bank data.",
	"memory.units-drift":
		"Reconcile installed memory units with deploy/memory via the runbook (docs/memory.md → Operator setup / Manual path) — the stack is never auto-deployed and installed Quadlets are operator-editable; doctor never copies, reloads or restarts.",
	sandbox:
		"Inspect the podman engine and the configured image locally; images are pulled only with operator approval.",
	"repo.test-ratio":
		"Informational: trim redundant tests or fold them into invariant-level ones (DESIGN.md → Test posture); never a gate.",
	"cache.contracts":
		"Run the bounded public-doc check `bun scripts/check-cache-contracts.ts` — it verifies the pinned source fragments only and never changes policy; empirical lifetime policies wait on model_cache_calls telemetry.",
	provider:
		"Provision the named credential record or codex auth file, or fix the model ref; doctor never resolves credentials or refreshes catalogs — refresh through ordinary authorized use.",
};

export function result(
	id: string,
	scope: string,
	status: HealthResult["status"],
	detail: string,
	start = performance.now(),
	next?: string,
): HealthResult {
	const hint =
		next ??
		(status === "fail" || status === "warn"
			? (manualHints[id] ?? manualHints[id.split(".")[0] ?? ""])
			: undefined);
	return {
		id,
		scope,
		status,
		detail,
		durationMs: Math.max(0, Math.round(performance.now() - start)),
		...(hint ? { next: hint } : {}),
	};
}
export function failure(
	id: string,
	scope: string,
	error: unknown,
	start: number,
	operation: string,
): HealthResult {
	return result(id, scope, "fail", `${operation}: ${errno(error)}`, start);
}

// O_NONBLOCK prevents a FIFO from hanging before fstat can reject it. The outer
// doctor worker watchdog also covers filesystems whose regular-file reads stall.
export function readBounded(path: string, cap = 256 * 1024): { text: string; mode: number } {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new ProbeError("not-regular-file");
		if (stat.size > cap) throw new ProbeError("oversized-file");
		const buffer = Buffer.alloc(cap + 1);
		let size = 0;
		while (size <= cap) {
			const n = readSync(fd, buffer, size, buffer.length - size, null);
			if (n === 0) break;
			size += n;
		}
		if (size > cap) throw new ProbeError("oversized-file");
		return { text: buffer.subarray(0, size).toString("utf8"), mode: stat.mode & 0o777 };
	} finally {
		closeSync(fd);
	}
}

export async function command(
	argv: string[],
	timeoutMs: number,
	probe: ProbeContext = {},
	statusMetadata = false,
): Promise<string> {
	const { signal, processGroup = "new" } = probe;
	if (signal?.aborted) throw new ProbeError("cancelled");
	let proc: Bun.ReadableSubprocess;
	try {
		proc = spawnProc(argv, undefined, undefined, processGroup);
	} catch (error) {
		throw new ProbeError(`spawn:${errno(error)}`);
	}
	// Inherited probes never signal the caller group; the outer collector owns it.
	const kill = () => killProc(proc, "SIGKILL", processGroup);
	const controller = new AbortController();
	let timedOut = false;
	const abort = () => {
		kill();
		controller.abort();
	};
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	const timer = setTimeout(() => {
		timedOut = true;
		abort();
	}, timeoutMs);
	try {
		const out = await boundedRun(proc, {
			timeoutMs: timeoutMs + 500,
			maxOutput: 64 * 1024,
			abortSignal: controller.signal,
			processGroup,
		});
		if (signal?.aborted) throw new ProbeError("cancelled");
		if (timedOut || out.timedOut) throw new ProbeError("deadline");
		if (out.truncated) {
			kill();
			throw new ProbeError("oversized-or-cut-output");
		}
		if (
			out.exitCode !== 0 &&
			!(
				statusMetadata &&
				/^[a-z][a-z0-9_-]{0,63}: (?:MISSING|LOCKED|BROKEN)  age=none  keys=0\n/.test(out.stdout)
			)
		)
			throw new ProbeError(`exit:${out.exitCode ?? "unreaped"}`);
		return out.stdout;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		kill();
	}
}

export function capacity(path: string, id: string, scope: string): HealthResult {
	const start = performance.now();
	try {
		const fs = statfsSync(path, { bigint: true });
		const bytes = fs.bavail * fs.bsize;
		const freePercent = fs.files > 0n ? Number((fs.ffree * 10000n) / fs.files) / 100 : null;
		const status =
			bytes < 1024n ** 3n || (freePercent !== null && freePercent < 1)
				? "fail"
				: bytes < 5n * 1024n ** 3n ||
						(freePercent !== null && freePercent < 10) ||
						freePercent === null
					? "warn"
					: "pass";
		return result(
			id,
			scope,
			status,
			`Available ${bytes} bytes; free inodes ${freePercent === null ? "unreported" : `${freePercent}%`}; capacity is not a write/fsync guarantee`,
			start,
		);
	} catch (error) {
		return failure(id, scope, error, start, `statfs ${path}`);
	}
}
