import { tool } from "ai";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { resolvePath } from "./paths.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 64 * 1024;
// Reads are whole-file, so gate on size first — a multi-GB log or database
// would OOM the process before the output cap ever applied. Bigger files
// get sliced with bash (sed/head/tail) instead.
const MAX_FILE_BYTES = 8 * 1024 * 1024;

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
			let raw: Buffer;
			try {
				const st = statSync(abs);
				if (st.isDirectory()) {
					return { error: `is a directory: ${path}` };
				}
				if (st.size > MAX_FILE_BYTES) {
					return {
						error: `file too large: ${path} (${st.size} bytes, max ${MAX_FILE_BYTES}) — slice it with bash (sed/head/tail)`,
					};
				}
				raw = readFileSync(abs);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					return { error: `file not found: ${path}` };
				}
				if ((err as NodeJS.ErrnoException).code === "EISDIR") {
					return { error: `is a directory: ${path}` };
				}
				throw err;
			}
			if (raw.subarray(0, 8192).includes(0)) {
				return { error: `binary file: ${path} (${raw.byteLength} bytes)` };
			}
			const text = raw.toString("utf8");
			const lines = text.split("\n");
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
