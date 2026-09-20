import { extname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { readTextFile } from "./read.ts";
import { resolvePath } from "./paths.ts";

export const speakInputSchema = z
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
	// Starts a record_voice chat action for the duration of the synthesis
	// and returns its stopper — the delivery sink's job, threaded through
	// the runtime (Telegram send is delivery, not a tool).
	recording?: () => () => void,
) {
	return tool({
		description: "Synthesize text or a plain-text/Markdown file and send it as Telegram voice notes.",
		inputSchema: speakInputSchema,
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
			const stopRecording = recording?.();
			try {
				const chunks = await synthesize(input!);
				for (const audio of chunks) await deliver(audio);
				return { sent: chunks.length };
			} catch (err) {
				log.warn("speak synthesis failed", { error: String(err) });
				return { error: `speech synthesis failed: ${String(err)}` };
			} finally {
				stopRecording?.();
			}
		},
	});
}
