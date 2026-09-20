import { extname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { readTextFile } from "./read.ts";
import { resolvePath } from "./paths.ts";

const inputSchema = z
	.object({
		text: z.string().min(1).optional(),
		path: z.string().min(1).optional(),
	})
	.refine((input) => (input.text === undefined) !== (input.path === undefined), {
		message: "provide exactly one of text or path",
	});

export function speakTool(
	cwd: string,
	synthesize: (text: string) => Promise<Uint8Array[]>,
	deliver: (audio: Uint8Array) => Promise<void>,
) {
	return tool({
		description: "Synthesize text or a plain-text/Markdown file and send it as Telegram voice notes.",
		inputSchema,
		execute: async ({ text, path }) => {
			let input = text;
			if (path !== undefined) {
				if (![".txt", ".md", ".markdown"].includes(extname(path).toLowerCase())) {
					return { error: "speak path must be a plain-text or Markdown file" };
				}
				const read = readTextFile(resolvePath(cwd, path), path);
				if ("error" in read) return read;
				input = read.text;
			}
			try {
				const chunks = await synthesize(input!);
				for (const audio of chunks) await deliver(audio);
				return { sent: chunks.length };
			} catch (err) {
				log.warn("speak synthesis failed", { error: String(err) });
				return { error: `speech synthesis failed: ${String(err)}` };
			}
		},
	});
}
