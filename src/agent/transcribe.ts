// Speech → text. When a `transcription` block is configured, intake
// transcribes voice/audio/video-note media once, eagerly, and the
// transcript rides inside the data-attachment part — durable history
// that materialization prefers over the bare path reference for models
// that can't consume audio (or payloads that don't fit the inline cap).
//
// The model is an AI SDK TranscriptionModelV2 fed to
// experimental_transcribe. `kind: groq` is the first — other kinds slot
// into transcriptionModel() as the SDK grows transcription providers.

import { readFile, stat } from "node:fs/promises";
import { experimental_transcribe } from "ai";
import type { TranscriptionModelV2 } from "@ai-sdk/provider";
import { createGroq } from "@ai-sdk/groq";
import type { AuthStore } from "../auth.ts";
import type { TranscriptionConfig } from "../config.ts";
import { log } from "../log.ts";

// Groq's multipart cap is 25 MiB — a bigger file is a guaranteed 413, so
// skip the request and leave the attachment path-referenced.
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 60_000;

export interface SpeechFile {
	path: string;
	mediaType: string;
	filename: string;
}

// Config → model. The auth ref resolves lazily at the point of use like
// every other provider — the resolved key never leaves this module.
export async function transcriptionModel(
	cfg: TranscriptionConfig,
	auth: AuthStore,
): Promise<TranscriptionModelV2> {
	switch (cfg.kind) {
		case "groq":
			return createGroq({ apiKey: await auth.resolve(cfg.auth) }).transcription(
				cfg.model,
			);
	}
}

// null = no transcript produced (over the provider's size cap, or the
// audio carried no speech). Provider/IO failures propagate — the intake
// caller degrades them to a warn + path-referenced attachment.
export async function transcribeAudio(
	model: TranscriptionModelV2,
	file: SpeechFile,
): Promise<string | null> {
	const { size } = await stat(file.path);
	if (size > TRANSCRIBE_MAX_BYTES) {
		log.warn("transcription skipped — file over provider cap", {
			file: file.filename,
			path: file.path,
			size,
			cap: TRANSCRIBE_MAX_BYTES,
		});
		return null;
	}
	const audio = await readFile(file.path);
	const result = await experimental_transcribe({
		model,
		audio,
		abortSignal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
	});
	const text = result.text.trim();
	log.info("transcribed", {
		file: file.filename,
		path: file.path,
		bytes: size,
		chars: text.length,
		...(result.language !== undefined ? { language: result.language } : {}),
		...(result.durationInSeconds !== undefined
			? { durationSec: result.durationInSeconds }
			: {}),
		...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
	});
	return text === "" ? null : text;
}
