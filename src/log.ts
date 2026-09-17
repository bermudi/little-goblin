// Structured logging. JSONL on stdout plus an append sink at
// $GOBLIN_HOME/state/goblin.log — a stable, durable location no matter
// how the process was launched. The only output channel — no
// console.log anywhere else in the codebase.
//
// The file sink must never take the process down or recurse: a failed
// append warns once on stdout and the sink stays dead for the run.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
	threshold = LEVELS[level];
}

// The file sink is opt-in: the composition root attaches it at boot
// (setLogFile). Anything else that logs — tests, one-off scripts —
// goes stdout-only and can't pollute the operator's log file.
let fileTarget: string | null = null;
let fileSinkDead = false;

export function setLogFile(path: string): void {
	fileTarget = path;
}

function writeFile(line: string): void {
	if (fileSinkDead || fileTarget === null) return;
	const target = fileTarget;
	try {
		appendFileSync(target, line);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			try {
				mkdirSync(dirname(target), { recursive: true });
				appendFileSync(target, line);
				return;
			} catch {
				// falls through to the dead-sink warn below
			}
		}
		fileSinkDead = true;
		process.stdout.write(
			JSON.stringify({
				ts: new Date().toISOString(),
				level: "warn",
				msg: "goblin.log sink failed — stdout only for this run",
				error: String(err),
			}) + "\n",
		);
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
