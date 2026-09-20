// Structured logging. JSONL on stdout plus an append sink at
// $GOBLIN_HOME/state/goblin.log — a stable, durable location no matter
// how the process was launched. The only output channel — no
// console.log anywhere else in the codebase.
//
// The file sink must never take the process down or recurse. Failures
// split two ways: permanent ones (bad path, permissions) kill the sink
// for the run after one warn; transient ones (disk full, EIO) keep the
// sink alive and retry on later writes — a full disk is exactly when
// the durable log matters most. Recovery logs one line.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
	threshold = LEVELS[level];
}

// The file sink is opt-in: the composition root attaches it at boot
// (setLogFile). Anything else that logs — tests, one-off scripts — goes
// stdout-only and can't pollute the operator's log file. Passing null
// detaches (tests do this after reading the file back).
let fileTarget: string | null = null;
let fileSinkDead = false;
let fileSinkDegraded = false;
let lastDegradedWarn = 0;

// Throttled while degraded — a full disk must not double every log
// line on stdout, but the condition may not go silent either.
const DEGRADED_WARN_INTERVAL_MS = 60_000;

// Errno that can clear without operator action — retry, don't die.
const TRANSIENT_ERRNOS = new Set(["ENOSPC", "EIO", "EAGAIN", "ENFILE", "EMFILE"]);

export function setLogFile(path: string | null): void {
	fileTarget = path;
	// Attaching a sink starts fresh: a dead or degraded sink from an
	// earlier target must not silence the new one.
	fileSinkDead = false;
	fileSinkDegraded = false;
}

// stdout warn that bypasses emit() — the file sink's own health must
// never route through the machinery whose failure it is reporting.
function warnStdout(msg: string, fields: Record<string, unknown>): void {
	process.stdout.write(
		JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg, ...fields }) + "\n",
	);
}

function writeFile(line: string): void {
	if (fileSinkDead || fileTarget === null) return;
	const target = fileTarget;
	try {
		appendFileSync(target, line);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			try {
				mkdirSync(dirname(target), { recursive: true });
				appendFileSync(target, line);
				return;
			} catch {
				// falls through to the dead-sink warn below
			}
		} else if (code !== undefined && TRANSIENT_ERRNOS.has(code)) {
			// Transient: keep the sink, retry on later writes. The line
			// itself already reached stdout; the warn is throttled.
			if (
				!fileSinkDegraded ||
				Date.now() - lastDegradedWarn >= DEGRADED_WARN_INTERVAL_MS
			) {
				lastDegradedWarn = Date.now();
				warnStdout("goblin.log sink degraded — retrying on later writes", {
					error: String(err),
				});
			}
			fileSinkDegraded = true;
			return;
		}
		fileSinkDead = true;
		warnStdout("goblin.log sink failed — stdout only for this run", {
			error: String(err),
		});
		return;
	}
	if (fileSinkDegraded) {
		fileSinkDegraded = false;
		warnStdout("goblin.log sink recovered", {});
	}
}

type Fields = Record<string, unknown>;

function emit(level: LogLevel, msg: string, fields?: Fields): void {
	if (LEVELS[level] < threshold) return;
	const line =
		JSON.stringify({
			ts: new Date().toISOString(),
			level,
			msg,
			...fields,
		}) + "\n";
	process.stdout.write(line);
	writeFile(line);
}

function errFields(err: unknown): Fields {
	if (err instanceof Error) {
		return { error: err.message, stack: err.stack };
	}
	return { error: String(err) };
}

export const log = {
	debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
	info: (msg: string, fields?: Fields) => emit("info", msg, fields),
	warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
	error: (msg: string, err?: unknown, fields?: Fields) =>
		emit("error", msg, { ...(err !== undefined ? errFields(err) : {}), ...fields }),
};
