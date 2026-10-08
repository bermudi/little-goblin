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
			// A differently-normalized twin may exist (macOS NFD vs NFC): write
			// to the twin, not beside it — otherwise the write silently forks
			// the file under a second spelling no tool ever resolves back to.
			const target = unicodeTwin(abs) ?? abs;
			// And write through a leaf symlink to the file it manages —
			// tmp+rename over the link would replace it and fork the config.
			const through = writeThroughTarget(target);
			if ("error" in through) return { error: through.error };
			const file = through.target;
			if (file !== target) log.info("write_through_symlink", { requested: target, resolved: file });
			mkdirSync(dirname(file), { recursive: true });
			durableWriteFile(file, content);
			return { path: file, bytes: Buffer.byteLength(content) };
		},
	});
