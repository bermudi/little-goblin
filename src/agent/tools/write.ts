import { tool } from "ai";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { durableWriteFile } from "../../durable.ts";
import { resolvePath } from "./paths.ts";

export const writeFileTool = (cwd: string) =>
	tool({
		description:
			"Write a file, replacing it entirely. Durable write (tmp + fsync + rename); parent directories are created.",
		inputSchema: z.object({
			path: z.string().describe("File path, relative to the working directory or absolute"),
			content: z.string(),
		}),
		execute: async ({ path, content }) => {
			const abs = resolvePath(cwd, path);
			mkdirSync(dirname(abs), { recursive: true });
			durableWriteFile(abs, content);
			return { path: abs, bytes: Buffer.byteLength(content) };
		},
	});
