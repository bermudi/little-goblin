import { tool } from "ai";
import { z } from "zod";
import { durableWriteFile } from "../../durable.ts";
import { log } from "../../log.ts";
import { resolvePath, unicodeTwin, writeThroughTarget } from "./paths.ts";
import { readTextFile } from "./read.ts";

export const editFileTool = (cwd: string) =>
	tool({
		description:
			"Replace exact text in a file. old_string must match uniquely unless replace_all is set. Leaf symlinks are followed to the file they manage.",
		inputSchema: z.object({
			path: z.string().describe("File path, relative to the working directory or absolute"),
			old_string: z.string().min(1),
			new_string: z.string(),
			replace_all: z.boolean().optional(),
		}),
		execute: async ({ path, old_string, new_string, replace_all }) => {
			// Resolve the unicode twin BEFORE reading, and read, write, and
			// report the same path: reading via the twin retry while writing
			// the requested spelling silently forks the file into two names.
			const abs = resolvePath(cwd, path);
			const target = unicodeTwin(abs) ?? abs;
			// And write through a leaf symlink to the file it manages —
			// tmp+rename over the link would replace it and fork the config.
			const through = writeThroughTarget(target);
			if ("error" in through) return { error: through.error };
			const file = through.target;
			if (file !== target) log.info("edit_through_symlink", { requested: target, resolved: file });
			const read = readTextFile(file, path);
			if ("error" in read) return read;
			const text = read.text;
			const count = text.split(old_string).length - 1;
			if (count === 0) {
				return { error: `old_string not found in ${path}` };
			}
			if (count > 1 && !replace_all) {
				return {
					error: `old_string matches ${count} times in ${path}; set replace_all or make it unique`,
				};
			}
			// Function replacer: new_string is literal — a string replacer
			// would interpret $&, $`, $', $n as special patterns.
			const next = replace_all
				? text.split(old_string).join(new_string)
				: text.replace(old_string, () => new_string);
			durableWriteFile(file, next);
			return { path: file, replaced: replace_all ? count : 1 };
		},
	});
