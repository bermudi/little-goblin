// Speech → text on demand. Intake transcribes voice and video notes
// eagerly (they're speech by construction), but attached audio — a song,
// a podcast, a recording to convert — is data: paying whisper for lyrics
// nobody asked for is the failure that motivates this split. The tool is
// the deliberate version of the same call, registered only when a
// `transcription` block is configured.

import { statSync } from "node:fs";
import { basename } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import type { SpeechFile } from "../transcribe.ts";
import { resolvePath, unicodeTwin } from "./paths.ts";

export const transcribeInputSchema = z.object({
	path: z
		.string()
		.describe("Path to an audio or video file, relative to the working directory or absolute"),
});

export function transcribeTool(
	cwd: string,
	transcribe: (file: SpeechFile) => Promise<string | null>,
) {
	return tool({
		description:
			"Transcribe an audio or video file to text — for media that didn't arrive as a voice note (attachments show up as [attachment: path — audio/…] references). Long files are segmented automatically.",
		inputSchema: transcribeInputSchema,
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
					// Extension-derived mime for the log line — the provider
					// only ever sees the bytes.
					mediaType: Bun.file(target).type || "application/octet-stream",
					filename: basename(target),
				});
				return text === null
					? { error: "no transcript produced — the audio may contain no speech" }
					: { transcript: text };
			} catch (err) {
				log.warn("transcribe tool failed", err, { path: target });
				return { error: `transcription failed: ${String(err)}` };
			}
		},
	});
}
