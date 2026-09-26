// Speech → text. When a `transcription` block is configured, intake
// transcribes voice and video notes once, eagerly — the media kinds
// Telegram only produces by recording speech — and the transcript rides
// inside the data-attachment part: durable history that materialization
// prefers over the bare path reference for models that can't consume
// audio (or payloads that don't fit the inline cap). Other audio —
// attached files — is transcribed on demand by the transcribe tool,
// which calls into this same module.
//
// The model is an AI SDK TranscriptionModelV2 fed to
// experimental_transcribe. `kind: groq` is the first — other kinds slot
// into transcriptionModel() as the SDK grows transcription providers.
//
// Over the provider's upload cap, the file is segmented instead of
// skipped: ffmpeg extracts the audio track to mono opus (a video note's
// payload is mostly pixels — the audio alone usually fits) and splits it
// into fixed-length chunks, transcribed sequentially and joined.

import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_transcribe } from "ai";
import type { TranscriptionModelV2 } from "@ai-sdk/provider";
import { createGroq } from "@ai-sdk/groq";
import type { AuthStore } from "../auth.ts";
import type { TranscriptionConfig } from "../config.ts";
import { log } from "../log.ts";
import { boundedRun, spawnProc } from "../proc.ts";

// Groq's multipart cap is 25 MiB — over that, segment instead of
// guessing at a request that 413s anyway.
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 60_000;

// 15 minutes of 48k mono opus ≈ 5.5 MiB — comfortably under the cap no
// matter the source bitrate.
const SEGMENT_SECONDS = 15 * 60;
const FFMPEG_TIMEOUT_MS = 180_000;

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

// Boot probe for speech features that need ffmpeg on PATH. Resolves
// false when the binary is missing or broken — the caller decides what
// that costs (TTS takes the feature down for the run; transcription
// only loses the over-cap segmentation path). The warn here is the
// audit trail either way.
export async function probeFfmpeg(feature = "transcription"): Promise<boolean> {
	try {
		const r = await boundedRun(spawnProc(["ffmpeg", "-version"]), {
			timeoutMs: 10_000,
			maxOutput: 8 * 1024,
		});
		if (r.exitCode !== 0) {
			throw new Error(`ffmpeg -version exited ${r.exitCode ?? "unreaped"}`);
		}
		return true;
	} catch (err) {
		log.warn("ffmpeg unavailable", { feature, error: String(err) });
		return false;
	}
}

export interface TranscribeOptions {
	// Provider upload cap — over it, the file is segmented first.
	maxBytes?: number;
	// Segment length for the over-cap path (tests shrink it; production
	// keeps SEGMENT_SECONDS).
	segmentSeconds?: number;
}

// null = no transcript produced (no speech found, or every segment
// failed — the per-segment warn carries why). ffmpeg absence, a corrupt
// file, and other IO/provider failures propagate — the intake caller
// degrades them to a warn + path-referenced attachment.
export async function transcribeAudio(
	model: TranscriptionModelV2,
	file: SpeechFile,
	opts: TranscribeOptions = {},
): Promise<string | null> {
	const { size } = await stat(file.path);
	if (size <= (opts.maxBytes ?? TRANSCRIBE_MAX_BYTES)) {
		return transcribeOne(model, file);
	}

	// Over the cap: audio-only opus segments in a scratch dir.
	const dir = await mkdtemp(join(tmpdir(), "goblin-tr-"));
	try {
		const segments = await segmentAudio(
			file.path,
			dir,
			opts.segmentSeconds ?? SEGMENT_SECONDS,
		);
		log.info("transcription segmented", {
			file: file.filename,
			path: file.path,
			bytes: size,
			segments: segments.length,
		});
		const texts: string[] = [];
		for (const seg of segments) {
			try {
				const t = await transcribeOne(model, { ...file, path: seg });
				if (t !== null) texts.push(t);
			} catch (err) {
				// Keep what transcribed — a partial transcript beats a bare
				// path, and the segment boundary tells the model where it ends.
				log.warn("transcription segment failed — result is partial", {
					file: file.filename,
					segment: seg,
					error: String(err),
				});
				break;
			}
		}
		return texts.length === 0 ? null : texts.join(" ");
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

// Extract the audio track to mono opus and split into fixed-length
// chunks — one pass handles both "video whose audio fits" (one segment)
// and "genuinely long recording" (many). Returns sorted chunk paths.
async function segmentAudio(
	src: string,
	dir: string,
	segmentSeconds: number,
): Promise<string[]> {
	const proc = spawnProc([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		src,
		"-vn",
		"-ac",
		"1",
		"-b:a",
		"48k",
		"-f",
		"segment",
		"-segment_time",
		String(segmentSeconds),
		"-reset_timestamps",
		"1",
		join(dir, "seg_%04d.ogg"),
	]);
	const r = await boundedRun(proc, {
		timeoutMs: FFMPEG_TIMEOUT_MS,
		maxOutput: 64 * 1024,
	});
	if (r.timedOut) {
		throw new Error(`ffmpeg segmentation timed out after ${FFMPEG_TIMEOUT_MS}ms`);
	}
	if (r.exitCode !== 0) {
		throw new Error(
			`ffmpeg segmentation exited ${r.exitCode ?? "unreaped"} — ${r.stderr.trim().slice(0, 400)}`,
		);
	}
	const segments = (await readdir(dir))
		.filter((f) => f.endsWith(".ogg"))
		.sort();
	if (segments.length === 0) {
		throw new Error("ffmpeg produced no segments — no audio track?");
	}
	return segments.map((f) => join(dir, f));
}

async function transcribeOne(
	model: TranscriptionModelV2,
	file: SpeechFile,
): Promise<string | null> {
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
		chars: text.length,
		...(result.language !== undefined ? { language: result.language } : {}),
		...(result.durationInSeconds !== undefined
			? { durationSec: result.durationInSeconds }
			: {}),
		...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
	});
	return text === "" ? null : text;
}
