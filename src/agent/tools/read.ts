import { tool } from "ai";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { resolvePath } from "./paths.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 64 * 1024;

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
			const start = (offset ?? 1) - 1;
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
