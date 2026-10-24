import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { z } from "zod";
import { goblinHome } from "./config.ts";
import { healthReportSchema, runHealth, type HealthReport } from "./health.ts";
import { setLogStream } from "./log.ts";
import { boundedRun, killProc, spawnProc } from "./proc.ts";

const optionsSchema = z.object({
	json: z.boolean().default(false),
	strict: z.boolean().default(false),
	phase: z.enum(["preflight", "installed"]).default("installed"),
	worker: z.boolean().default(false),
	help: z.boolean().default(false),
});
export type DoctorOptions = z.infer<typeof optionsSchema>;

export function parseDoctorArgs(args: string[]): DoctorOptions {
	const { values } = parseArgs({
		args,
		options: {
			json: { type: "boolean" },
			strict: { type: "boolean" },
			phase: { type: "string" },
			worker: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: false,
	});
	return optionsSchema.parse(values);
}

export function reportExitCode(report: HealthReport, strict = false): number {
	return report.results.some((r) => r.status === "fail" || (strict && r.status === "warn")) ? 1 : 0;
}

function printable(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "\uFFFD");
}

export function formatDoctorReport(report: HealthReport): string {
	const lines = [
		`Doctor — ${report.phase}`,
		`Home: ${printable(report.target.home)}`,
		`Checkout: ${printable(report.target.checkout)}`,
		"",
	];
	const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
	for (const result of report.results) {
		counts[result.status]++;
		lines.push(
			`${result.status.toUpperCase().padEnd(4)} ${printable(result.id)} [${printable(result.scope)}] ${printable(result.detail)} (${result.durationMs} ms)`,
		);
		if (result.next) lines.push(`     Next: ${printable(result.next)}`);
	}
	lines.push(
		"",
		`${counts.pass} passed, ${counts.warn} warnings, ${counts.fail} failed, ${counts.skip} skipped`,
	);
	return `${lines.join("\n")}\n`;
}

// A process boundary, not Promise.race, bounds synchronous filesystem/SQLite
// work too. Never forward arbitrary worker stderr or invalid report bodies.
export async function collectDoctorReport(options: {
	phase: DoctorOptions["phase"];
	timeoutMs?: number;
	workerCommand?: string[];
	signal?: AbortSignal;
}): Promise<HealthReport> {
	const proc = spawnProc(
		options.workerCommand ?? [
			process.execPath,
			"--no-install",
			import.meta.path,
			"--worker",
			"--phase",
			options.phase,
		],
	);
	// Outer shell callers can have a shorter kill grace than this collector.
	const abort = (): void => killProc(proc, "SIGKILL");
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	let result;
	try {
		result = await boundedRun(proc, {
			timeoutMs: options.timeoutMs ?? 45_000,
			maxOutput: 1_048_576,
			...(options.signal ? { abortSignal: options.signal } : {}),
		});
	} finally {
		options.signal?.removeEventListener("abort", abort);
		// The group remains ours after leader exit; stalled workers cannot clean it.
		killProc(proc, "SIGKILL");
	}
	if (options.signal?.aborted) throw new Error("diagnostics cancelled");
	if (result.timedOut) throw new Error("diagnostic deadline exceeded");
	if (result.truncated) throw new Error("diagnostic output exceeded its limit");
	if (result.exitCode !== 0) throw new Error("diagnostic worker failed");
	let raw: unknown;
	try {
		raw = JSON.parse(result.stdout);
	} catch {
		throw new Error("diagnostic worker returned an invalid report");
	}
	const parsed = healthReportSchema.safeParse(raw);
	if (!parsed.success) throw new Error("diagnostic worker returned an invalid report");
	return parsed.data;
}

async function main(): Promise<number> {
	// stdout is exactly one report in every mode (the worker's JSON line,
	// --json, or the formatted text): any runtime diagnostic this process
	// emits belongs on stderr (design/doctor.md — a scoped exception to
	// ordinary runtime stdout logging).
	setLogStream(process.stderr);
	let options: DoctorOptions;
	try {
		options = parseDoctorArgs(process.argv.slice(2));
	} catch {
		process.stderr.write(
			"doctor: invalid arguments; use [--json] [--strict] [--phase preflight|installed]\n",
		);
		return 2;
	}
	if (options.help) {
		process.stdout.write(
			"Usage: bun run doctor [--json] [--strict] [--phase preflight|installed]\nRead-only checks; configured failures exit 1, command errors exit 2. --strict also fails warnings.\n",
		);
		return 0;
	}
	if (options.worker) {
		const signal = new AbortController();
		process.on("SIGTERM", () => signal.abort());
		process.on("SIGINT", () => signal.abort());
		const report = await runHealth({
			home: goblinHome(),
			checkout: resolve(import.meta.dir, ".."),
			phase: options.phase,
			signal: signal.signal,
			probe: { processGroup: "inherit" },
		});
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return 0;
	}
	const signal = new AbortController();
	const abort = () => signal.abort();
	process.on("SIGTERM", abort);
	process.on("SIGINT", abort);
	let report: HealthReport;
	try {
		report = await collectDoctorReport({ phase: options.phase, signal: signal.signal });
	} finally {
		process.removeListener("SIGTERM", abort);
		process.removeListener("SIGINT", abort);
	}
	process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : formatDoctorReport(report));
	return reportExitCode(report, options.strict);
}

if (import.meta.main) {
	try {
		process.exitCode = await main();
	} catch (error) {
		// Only locally constructed categories escape the worker boundary.
		const safe =
			error instanceof Error &&
			[
				"diagnostic deadline exceeded",
				"diagnostic output exceeded its limit",
				"diagnostic worker failed",
				"diagnostic worker returned an invalid report",
				"diagnostics cancelled",
			].includes(error.message)
				? error.message
				: "diagnostics could not produce a report";
		process.stderr.write(`doctor: ${safe}\n`);
		process.exitCode = 2;
	}
}
