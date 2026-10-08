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

// Injectable for tests (same pattern as codex/auth.ts's fetchImpl): a fake
// writer can fail with a chosen errno, which the real filesystem can't
// be asked to do portably. Passing null restores the real one.
export type AppendFn = (path: string, line: string) => void;
let appendImpl: AppendFn = (path, line) => appendFileSync(path, line);

export function setLogWriter(fn: AppendFn | null): void {
	appendImpl = fn ?? ((path, line) => appendFileSync(path, line));
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
		try {
			appendImpl(target, line);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			mkdirSync(dirname(target), { recursive: true });
			appendImpl(target, line);
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== undefined && TRANSIENT_ERRNOS.has(code)) {
			// Transient — from either append, including the ENOENT retry:
			// keep the sink, retry on later writes. The line itself
			// already reached stdout; the warn is throttled.
			if (!fileSinkDegraded || Date.now() - lastDegradedWarn >= DEGRADED_WARN_INTERVAL_MS) {
				lastDegradedWarn = Date.now();
				warnStdout("goblin.log sink degraded — retrying on later writes", errFields(err));
			}
			fileSinkDegraded = true;
			return;
		}
		fileSinkDead = true;
		warnStdout("goblin.log sink failed — stdout only for this run", errFields(err));
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

// Cause-chain capture. Errors are thrown wrapped with {cause} at
// several boundaries (tg/inbox, tg/mod, provider-errors), and the
// wrapper's message alone rarely explains the failure. The walk is
// bounded and cycle-safe: a cause chain is untrusted structure, never
// a reason to lose the log line.
const MAX_CAUSES = 3;

// One cause as a JSON-safe {message, stack} entry. A raw Error must
// never leak into the line — it serializes to {} (own enumerable
// properties only) and swallows the only field that mattered.
function causeFields(value: unknown): Fields {
	if (value instanceof Error) return { message: value.message, stack: value.stack };
	// Error-shaped causes from other realms carry a string message worth
	// keeping; everything else degrades to String(). Never JSON.stringify
	// here — a cyclic cause object would throw inside the logger itself.
	if (typeof value === "object" && value !== null && "message" in value) {
		const message = (value as { message: unknown }).message;
		if (typeof message === "string") return { message };
	}
	return { message: String(value) };
}

function errFields(err: unknown): Fields {
	if (!(err instanceof Error)) return { error: String(err) };
	const fields: Fields = { error: err.message, stack: err.stack };
	const causes: Fields[] = [];
	const seen = new Set<object>([err]);
	let current: unknown = err.cause;
	while (current !== null && current !== undefined && causes.length < MAX_CAUSES) {
		if (typeof current !== "object") {
			// A primitive cause ({cause: "why"} is legal JS) still carries
			// its text — and primitives can't extend the chain further.
			causes.push({ message: String(current) });
			break;
		}
		if (seen.has(current)) break;
		seen.add(current);
		causes.push(causeFields(current));
		current = (current as { cause?: unknown }).cause;
	}
	if (causes.length > 0) fields.cause = causes;
	return fields;
}

// warn gets error-level treatment when handed one: message, stack, and
// the cause chain join the line. The overloads keep every existing
// two-arg site — warn(msg, fields) — untouched: a plain object still
// means fields, while an Error (not assignable to Fields) routes to
// the err overload.
function warn(msg: string, fields?: Fields): void;
function warn(msg: string, err: unknown, fields?: Fields): void;
function warn(msg: string, a?: unknown, b?: Fields): void {
	// Runtime dispatch mirrors overload resolution: plain object →
	// fields; Error, primitive, or null → err; absent → fields-only.
	const isErr = a !== undefined && (typeof a !== "object" || a === null || a instanceof Error);
	if (isErr) {
		emit("warn", msg, { ...errFields(a), ...b });
	} else {
		emit("warn", msg, { ...(a as Fields | undefined), ...b });
	}
}

export const log = {
	debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
	info: (msg: string, fields?: Fields) => emit("info", msg, fields),
	warn,
	error: (msg: string, err?: unknown, fields?: Fields) =>
		emit("error", msg, { ...(err !== undefined ? errFields(err) : {}), ...fields }),
};
