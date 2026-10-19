import { extname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { readTextFile } from "./read.ts";
import { resolvePath } from "./paths.ts";

// z.never rejects a hallucinated voice — the call errors instead of a silent
// strip that leaves the model believing it spoke the requested language.
export function speakInputSchema(voices?: readonly string[]) {
	const allowed = voices?.length ? ([...new Set(voices)] as [string, ...string[]]) : null;
	return z
		.object({
			text: z.string().min(1).optional(),
			path: z.string().min(1).optional(),
			voice: allowed
				? z
						.enum(allowed)
						.optional()
						.describe("match the text's language; omit to let goblin pick by language")
				: z.never().optional().describe("no alternate voices configured — omit"),
		})
		.refine((input) => (input.text === undefined) !== (input.path === undefined), {
			message: "provide exactly one of text or path",
		});
}

export function speakTool(
	cwd: string,
	synthesize: (text: string, voice?: string) => Promise<Uint8Array[]>,
	deliver: (audio: Uint8Array) => Promise<void>,
	recording?: () => () => void,
	voices?: readonly string[],
) {
	const allowed = voices?.length ? [...new Set(voices)] : null;
	return tool({
		description:
			"Synthesize text or a plain-text/Markdown file and send it as Telegram voice notes." +
			(allowed ? ` Voice (optional, match the text's language): ${allowed.join(", ")}.` : ""),
		inputSchema: speakInputSchema(voices),
		execute: async ({ text, path, voice }) => {
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
				const chunks = await synthesize(input!, voice);
				for (const audio of chunks) await deliver(audio);
				return { sent: chunks.length };
			} catch (err) {
				log.warn("speak synthesis failed", err);
				return { error: `speech synthesis failed: ${String(err)}` };
			} finally {
				stopRecording?.();
			}
		},
	});
}
