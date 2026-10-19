import { tool } from "ai";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { durableWriteFile } from "../../durable.ts";
import { log } from "../../log.ts";
import { resolvePath, unicodeTwin, writeThroughTarget } from "./paths.ts";

export const writeFileTool = (cwd: string) =>
	tool({
		description:
			"Write a file, replacing it entirely. Durable write (tmp + fsync + rename); parent directories are created. Leaf symlinks are followed to the file they manage.",
		inputSchema: z.object({
			path: z.string().describe("File path, relative to the working directory or absolute"),
			content: z.string(),
		}),
		execute: async ({ path, content }) => {
			const abs = resolvePath(cwd, path);
			const target = unicodeTwin(abs) ?? abs;
			const through = writeThroughTarget(target);
			if ("error" in through) return { error: through.error };
			const file = through.target;
			if (file !== target) log.info("write_through_symlink", { requested: target, resolved: file });
			mkdirSync(dirname(file), { recursive: true });
			durableWriteFile(file, content);
			return { path: file, bytes: Buffer.byteLength(content) };
		},
	});
