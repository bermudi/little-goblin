// The file sink must never take the process down or recurse. Permanent
// failures (bad path, permissions) kill the sink for the run after one
// warn; transient (disk full, EIO) retry on later writes — a full disk
// is exactly when the durable log matters most.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
	threshold = LEVELS[level];
}

// Opt-in: only the composition root attaches it — tests and one-off
// scripts go stdout-only and can't pollute the operator's log file.
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

// Injectable for tests — a fake writer can fail with a chosen errno,
// which the real filesystem can't be asked to do portably.
export type AppendFn = (path: string, line: string) => void;
let appendImpl: AppendFn = (path, line) => appendFileSync(path, line);

export function setLogWriter(fn: AppendFn | null): void {
	appendImpl = fn ?? ((path, line) => appendFileSync(path, line));
}

// Where emitted lines land. Doctor's worker and collector redirect this
// to stderr: their stdout must be exactly one JSON report, and a
// runtime diagnostic interleaved into it (boundedRun's pipe
// cancel/drain warns in particular) breaks every consumer
// (design/doctor.md — "operational diagnostics belong on stderr").
let stream: NodeJS.WriteStream = process.stdout;

// Injectable for tests — null restores the default stdout routing.
export function setLogStream(target: NodeJS.WriteStream | null): void {
	stream = target ?? process.stdout;
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
			// Transient from either append, including the ENOENT retry —
			// the line already reached stdout; the warn is throttled.
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

function emit(level: LogLevel, msg: string, fields?: Fields, startup = false): void {
	if (!startup && LEVELS[level] < threshold) return;
	const line =
		JSON.stringify({
			ts: new Date().toISOString(),
			level,
			msg,
			...fields,
		}) + "\n";
	stream.write(line);
	writeFile(line);
}

// The walk is bounded and cycle-safe: a cause chain is untrusted
// structure, never a reason to lose the log line.
const MAX_CAUSES = 3;

// A raw Error must never leak into the line — it serializes to {}
// (own enumerable properties only) and swallows the message.
function causeFields(value: unknown): Fields {
	if (value instanceof Error) return { message: value.message, stack: value.stack };
	// Never JSON.stringify here — a cyclic cause object would throw
	// inside the logger itself.
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
			// {cause: "why"} is legal JS; primitives can't extend the chain.
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

// warn(msg, err) captures message+stack+cause chain; a plain object is
// fields, an Error (not assignable to Fields) routes to the err overload.
function warn(msg: string, fields?: Fields): void;
function warn(msg: string, err: unknown, fields?: Fields): void;
function warn(msg: string, a?: unknown, b?: Fields): void {
	// Mirrors the overloads: plain object → fields; Error/primitive/null
	// → err; absent → fields-only.
	const isErr = a !== undefined && (typeof a !== "object" || a === null || a instanceof Error);
	if (isErr) {
		emit("warn", msg, { ...errFields(a), ...b });
	} else {
		emit("warn", msg, { ...(a as Fields | undefined), ...b });
	}
}

// Only these startup signals bypass the threshold; arbitrary info still obeys it.
type StartupEvent =
	| [msg: "goblin up", fields: { home: string; port?: number }]
	| [msg: "long polling started"];

export const log = {
	startup: (...[msg, fields]: StartupEvent) => emit("info", msg, fields, true),
	debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
	info: (msg: string, fields?: Fields) => emit("info", msg, fields),
	warn,
	error: (msg: string, err?: unknown, fields?: Fields) =>
		emit("error", msg, { ...(err !== undefined ? errFields(err) : {}), ...fields }),
};
