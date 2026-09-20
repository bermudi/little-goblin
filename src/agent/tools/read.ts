import { tool } from "ai";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { resolvePath } from "./paths.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 64 * 1024;
// Reads are whole-file, so gate on size first — a multi-GB log or database
// would OOM the process before the output cap ever applied. Bigger files
// get sliced with bash (sed/head/tail) instead.
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

// Whole-file read guarded for tool use — shared by read_file and edit_file
// (edit_file needs the same gates: it reads the whole file too, and a
// binary file decoded as utf8 would be corrupted on write-back).
export function readTextFile(abs: string, display: string): { text: string } | { error: string } {
	let raw: Buffer;
	try {
		const st = statSync(abs);
		if (st.isDirectory()) {
			return { error: `is a directory: ${display}` };
		}
		if (st.size > MAX_FILE_BYTES) {
			return {
				error: `file too large: ${display} (${st.size} bytes, max ${MAX_FILE_BYTES}) — slice it with bash (sed/head/tail)`,
			};
		}
		raw = readFileSync(abs);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { error: `file not found: ${display}` };
		}
		if ((err as NodeJS.ErrnoException).code === "EISDIR") {
			return { error: `is a directory: ${display}` };
		}
		throw err;
	}
	if (raw.includes(0)) {
		return { error: `binary file: ${display} (${raw.byteLength} bytes)` };
	}
	// Fatal decode: lossy utf8 would let invalid bytes through, and
	// edit_file writes the decoded text back — corrupting the file.
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(raw) };
	} catch {
		return { error: `binary file: ${display} (${raw.byteLength} bytes)` };
	}
}

export const readFileTool = (cwd: string) =>
	tool({
		description:
			"Read a file's contents with line numbers. offset is 1-based; limit caps lines returned. " +
			`Output is capped at ${MAX_LINES} lines / ${MAX_BYTES / 1024}KB — the cap notice says which offset continues the file.`,
		inputSchema: z.object({
			path: z.string().describe("File path, relative to the working directory or absolute"),
			offset: z.number().int().positive().optional(),
			limit: z.number().int().positive().optional(),
		}),
		execute: async ({ path, offset, limit }) => {
			const abs = resolvePath(cwd, path);
			const read = readTextFile(abs, path);
			if ("error" in read) return read;
			const lines = read.text.split("\n");
			const total = lines.length;

			// An offset past EOF is an error with the real count, not a silent
		// empty read — the model can't tell "empty file" from "bad guess"
		// otherwise.
			if (offset !== undefined && offset > total) {
				return { error: `offset ${offset} is beyond end of file (${total} lines)` };
			}
			const start = (offset ?? 1) - 1;
			// The user's limit is honored first; caps apply to what they asked for.
			const limitEnd = limit !== undefined ? Math.min(start + limit, total) : total;

			// A single line bigger than the whole output cap can't be shown at
			// all — point at the bash fallback instead of emitting a marker that
			// carries no content.
			const firstLine = `${start + 1}\t${lines[start] ?? ""}\n`;
			if (Buffer.byteLength(firstLine, "utf8") > MAX_BYTES) {
				return {
					content:
					`Line ${start + 1} alone is ${Buffer.byteLength(firstLine, "utf8")} bytes — exceeds the ${MAX_BYTES / 1024}KB read_file cap. ` +
					`Slice it with bash: sed -n '${start + 1}p' "${path}" | head -c ${MAX_BYTES}`,
					lines: total,
					shown: 0,
				};
			}

			// Emit complete numbered lines only — never a partial line — stopping
		// at whichever cap hits first (line count or output bytes, line-number
		// prefixes included in the byte accounting).
			const out: string[] = [];
			let bytes = 0;
			let shown = 0;
			let i = start;
			for (; i < limitEnd && shown < MAX_LINES; i++) {
				const line = `${i + 1}\t${lines[i] ?? ""}\n`;
				if (bytes + Buffer.byteLength(line, "utf8") > MAX_BYTES) break;
				out.push(line);
				bytes += Buffer.byteLength(line, "utf8");
				shown++;
			}

			// The continuation notice is the point of pre-capping: whenever
			// output stops short, it names the exact offset that resumes the
			// file, so paging is one call away instead of a guessing game.
			let notice = "";
			if (shown < MAX_LINES && i < limitEnd) {
				notice = `\n[Showing lines ${start + 1}–${i} of ${total} (${MAX_BYTES / 1024}KB limit). Use offset=${i + 1} to continue.]`;
			} else if (shown >= MAX_LINES && start + shown < limitEnd) {
				notice = `\n[Showing lines ${start + 1}–${start + shown} of ${total} (${MAX_LINES}-line limit). Use offset=${start + shown + 1} to continue.]`;
			} else if (limitEnd < total) {
				notice = `\n[${total - limitEnd} more lines in file. Use offset=${limitEnd + 1} to continue.]`;
			}
			return { content: out.join("") + notice, lines: total, shown };
		},
	});
