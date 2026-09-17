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
	if (raw.subarray(0, 8192).includes(0)) {
		return { error: `binary file: ${display} (${raw.byteLength} bytes)` };
	}
	return { text: raw.toString("utf8") };
}

export const readFileTool = (cwd: string) =>
	tool({
		description:
			"Read a file's contents with line numbers. offset is 1-based; limit caps lines returned.",
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
			// Clamp: an offset past EOF yields empty content, not a negative
			// `shown` count.
			const start = Math.min((offset ?? 1) - 1, lines.length);
			const end = Math.min(lines.length, start + (limit ?? MAX_LINES));
			let out = "";
			for (let i = start; i < end; i++) {
				const line = `${i + 1}\t${lines[i] ?? ""}\n`;
				if (out.length + line.length > MAX_BYTES) {
					out += `… truncated at ${MAX_BYTES} bytes …`;
					break;
				}
				out += line;
			}
			return { content: out, lines: lines.length, shown: end - start };
		},
	});
