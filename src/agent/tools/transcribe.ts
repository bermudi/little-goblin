import { statSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { defineTool } from "../../tool.ts";
import { paths } from "../../home-layout.ts";
import { log } from "../../log.ts";
import type { SpeechFile } from "../transcribe.ts";
import { resolvePath, unicodeTwin } from "./paths.ts";
import { truncatedFooter, trySpill, windowText } from "./truncate.ts";

// Same budget as bash and fetch: a multi-hour file is hundreds of
// thousands of chars, and all of it used to land in context (#668).
const TRANSCRIPT_BUDGET = 15_000;

export const transcribeInputSchema = z.object({
	path: z
		.string()
		.describe("Path to an audio or video file, relative to the working directory or absolute"),
});

export function transcribeTool(
	cwd: string,
	transcribe: (file: SpeechFile) => Promise<string | null>,
) {
	return defineTool({
		description:
			"Transcribe an audio or video file to text — for media that didn't arrive as a voice note (attachments show up as [attachment: path — audio/…] references). Long files are segmented automatically. A long transcript comes back as its start and end, with the full text saved to a file the result names.",
		input: transcribeInputSchema,
		execute: async ({ path }) => {
			const abs = resolvePath(cwd, path);
			const target = unicodeTwin(abs) ?? abs;
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(target);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					return { error: `file not found: ${path}` };
				}
				throw err;
			}
			if (st.isDirectory()) return { error: `is a directory: ${path}` };
			if (st.isCharacterDevice() || st.isBlockDevice() || st.isFIFO() || st.isSocket()) {
				return {
					error: `refusing to transcribe special file (device/fifo/socket): ${path}`,
				};
			}
			try {
				const text = await transcribe({
					path: target,
					mediaType: Bun.file(target).type || "application/octet-stream",
					filename: basename(target),
				});
				if (text === null) {
					return { error: "no transcript produced — the audio may contain no speech" };
				}
				if (text.length <= TRANSCRIPT_BUDGET) return { transcript: text };
				const file = trySpill(paths.transcriptcache(), text);
				log.info("transcript spilled", { path: target, file, chars: text.length });
				return {
					transcript:
						windowText(text, TRANSCRIPT_BUDGET).window + truncatedFooter(file, text.length),
					truncated: true,
				};
			} catch (err) {
				log.warn("transcribe tool failed", err, { path: target });
				return { error: `transcription failed: ${String(err)}` };
			}
		},
	});
}
