import { tool } from "ai";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { durableWriteFile } from "../../durable.ts";
import { resolvePath, unicodeTwin } from "./paths.ts";

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
			// A differently-normalized twin may exist (macOS NFD vs NFC): write
			// to the twin, not beside it — otherwise the write silently forks
			// the file under a second spelling no tool ever resolves back to.
			const target = unicodeTwin(abs) ?? abs;
			mkdirSync(dirname(target), { recursive: true });
			durableWriteFile(target, content);
			return { path: target, bytes: Buffer.byteLength(content) };
		},
	});
