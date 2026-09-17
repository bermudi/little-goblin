// Structured logging. JSONL on stdout. The only output channel — no
// console.log anywhere else in the codebase.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
	threshold = LEVELS[level];
}

type Fields = Record<string, unknown>;

function emit(level: LogLevel, msg: string, fields?: Fields): void {
	if (LEVELS[level] < threshold) return;
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		msg,
		...fields,
	});
	process.stdout.write(line + "\n");
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
