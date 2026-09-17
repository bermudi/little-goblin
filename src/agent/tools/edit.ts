import { tool } from "ai";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { durableWriteFile } from "../../durable.ts";
import { resolvePath } from "./paths.ts";

export const editFileTool = (cwd: string) =>
	tool({
		description:
			"Replace exact text in a file. old_string must match uniquely unless replace_all is set.",
		inputSchema: z.object({
			path: z.string().describe("File path, relative to the working directory or absolute"),
			old_string: z.string().min(1),
			new_string: z.string(),
			replace_all: z.boolean().optional(),
		}),
		execute: async ({ path, old_string, new_string, replace_all }) => {
			const abs = resolvePath(cwd, path);
			let text: string;
			try {
				text = readFileSync(abs, "utf8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					return { error: `file not found: ${path}` };
				}
				throw err;
			}
			const count = text.split(old_string).length - 1;
			if (count === 0) {
				return { error: `old_string not found in ${path}` };
			}
			if (count > 1 && !replace_all) {
				return { error: `old_string matches ${count} times in ${path}; set replace_all or make it unique` };
			}
			// Function replacer: new_string is literal — a string replacer
			// would interpret $&, $`, $', $n as special patterns.
			const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string);
			durableWriteFile(abs, next);
			return { path: abs, replaced: replace_all ? count : 1 };
		},
	});
