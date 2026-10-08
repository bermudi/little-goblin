import { extname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { readTextFile } from "./read.ts";
import { resolvePath } from "./paths.ts";

// The voice param exists only when the operator configured alternates
// (tts.voices). With none configured, z.never rejects a hallucinated
// voice — the call errors and the model drops the param, instead of a
// silent strip leaving it believing it spoke the requested language.
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
	// Starts a record_voice chat action for the duration of the synthesis
	// and returns its stopper — the delivery sink's job, threaded through
	// the runtime (Telegram send is delivery, not a tool).
	recording?: () => () => void,
	// Full allowlist (default included) when the operator configured
	// alternates; explicitly picking the default is a no-op.
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
