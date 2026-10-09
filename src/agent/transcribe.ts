// Speech → text. When a `transcription` block is configured, intake
// transcribes voice and video notes once, eagerly — the media kinds
// Telegram only produces by recording speech — and the transcript rides
// inside the data-attachment part: durable history that materialization
// prefers over the bare path reference for models that can't consume
// audio (or payloads that don't fit the inline cap). Other audio —
// attached files — is transcribed on demand by the transcribe tool,
// which calls into this same module.
//
// Engines implement SpeechEngine (design/asr.md); the orchestrator owns
// segmentation, silence semantics, and the log line, and never sees a
// provider SDK. Engines hand-roll their HTTP (groq multipart here moves
// to transcribe-cloud.ts) like TTS already does — the AI SDK's
// transcribe() path is gone from this layer.

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStore } from "../auth.ts";
import type { TranscriptionConfig } from "../config.ts";
import { log } from "../log.ts";
import { boundedRun, spawnProc } from "../proc.ts";
import { groqEngine } from "./transcribe-cloud.ts";

const FFMPEG_TIMEOUT_MS = 180_000;

// Hard ceiling on one transcription's segment count (≈1 h 52 m at the
// whistle profile's 28 s) — past it, fail loud instead of grinding the
// CPU for an afternoon.
const MAX_SEGMENTS = 240;

export interface SpeechFile {
	path: string;
	mediaType: string;
	filename: string;
}

export interface EngineTranscript {
	text: string;
	language?: string | undefined;
}

// One engine = one prepared-file → transcript function plus the prep
// contract the orchestrator must honor before calling it. `id` is the
// log line's provider field ("whistle", "groq/whisper-large-v3-turbo").
export interface SpeechEngine {
	id: string;
	// What the orchestrator must guarantee per call: upload cap for
	// keep-profile engines, and the per-segment ceiling both profiles
	// segment at.
	limits: { maxBytes?: number; maxSeconds?: number };
	// keep: pass the original bytes under the cap; over it (or always,
	// for wav) run the ffmpeg segmentation pass. sampleRateHz/mono shape
	// the wav profile (whistle: 16 kHz mono).
	prep: { container: "keep" | "wav"; sampleRateHz?: number; mono?: boolean };
	transcribe(file: SpeechFile): Promise<EngineTranscript>;
}

// Injectable engine dependencies (tests fake fetch and the process
// shape); production defaults live in the engine modules.
export interface EngineDeps {
	fetchFn?: typeof fetch;
}

// Config → engine. The auth ref resolves lazily at the point of use like
// every other provider — the resolved key never leaves the engine.
export function speechEngine(
	cfg: TranscriptionConfig,
	auth: AuthStore,
	deps: EngineDeps = {},
): SpeechEngine {
	switch (cfg.kind) {
		case "groq":
			return groqEngine(cfg, auth, deps);
	}
}

// Boot probe for speech features that need ffmpeg on PATH. Resolves
// false when the binary is missing or broken — the caller decides what
// that costs (TTS takes the feature down for the run; transcription
// degrades per message: keep-profile engines only lose the over-cap
// path, wav-profile engines lose everything). The warn here is the
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
		log.warn("ffmpeg unavailable", err, { feature });
		return false;
	}
}

export interface TranscribeOptions {
	// Provider upload cap override — over it, the file is segmented first.
	maxBytes?: number;
	// Segment length override (tests shrink it; production keeps the
	// engine's own limit).
	segmentSeconds?: number;
}

// null = no speech found (an empty transcript under the cap, or every
// segment empty over it). Failures — including a provider outage that
// leaves the segmented path with zero transcribed segments — propagate
// instead: a failure must never read as silence. ffmpeg absence, a
// corrupt file, and other IO/provider failures propagate the same way
// — the intake caller degrades them to a warn + path-referenced
// attachment.
export async function transcribeAudio(
	engine: SpeechEngine,
	file: SpeechFile,
	opts: TranscribeOptions = {},
): Promise<string | null> {
	const maxBytes = opts.maxBytes ?? engine.limits.maxBytes;
	const segmentSeconds = opts.segmentSeconds ?? engine.limits.maxSeconds;
	if (engine.prep.container === "wav") {
		// The wav profile always transcodes: the local engine only eats
		// 16 kHz mono RIFF, so even a short note is one segment pass.
		return transcribeSegmented(engine, file, (dir) =>
			segmentAudio(file.path, dir, segmentSeconds ?? 28, {
				container: "wav",
				sampleRateHz: engine.prep.sampleRateHz,
				mono: engine.prep.mono,
			}),
		);
	}
	if (maxBytes === undefined || (await stat(file.path)).size <= maxBytes) {
		return transcribeOne(engine, file);
	}
	return transcribeSegmented(engine, file, (dir) =>
		segmentAudio(file.path, dir, segmentSeconds ?? 15 * 60, {
			container: "keep",
			sampleRateHz: undefined,
			mono: undefined,
		}),
	);
}

async function transcribeSegmented(
	engine: SpeechEngine,
	file: SpeechFile,
	segment: (dir: string) => Promise<string[]>,
): Promise<string | null> {
	const dir = await mkdtemp(join(tmpdir(), "goblin-tr-"));
	try {
		const segments = await segment(dir);
		if (segments.length > MAX_SEGMENTS) {
			throw new Error(
				`transcription needs ${segments.length} segments (max ${MAX_SEGMENTS}) — split the file or use a faster engine`,
			);
		}
		log.info("transcription segmented", {
			file: file.filename,
			path: file.path,
			segments: segments.length,
			engine: engine.id,
		});
		const texts: string[] = [];
		for (const seg of segments) {
			try {
				const t = await transcribeOne(engine, {
					path: seg,
					// Extension-derived mime for multipart engines; the
					// local engine only ever sees the path.
					mediaType: seg.endsWith(".wav") ? "audio/wav" : "audio/ogg",
					filename: seg,
				});
				if (t !== null) texts.push(t);
			} catch (err) {
				// Keep what transcribed — a partial transcript beats a bare
				// path, and the segment boundary tells the model where it ends.
				log.warn("transcription segment failed — result is partial", err, {
					file: file.filename,
					segment: seg,
				});
				// Nothing transcribed means there is no partial to keep:
				// returning null would read as "no speech" to every caller
				// (#101) — the provider error must name itself instead.
				if (texts.length === 0) throw err;
				break;
			}
		}
		return texts.length === 0 ? null : texts.join(" ");
	} finally {
		await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
			log.warn("transcription scratch cleanup failed", err, { dir });
		});
	}
}

interface PrepSpec {
	container: "keep" | "wav";
	// Optional fields carry explicit undefined: they're forwarded from
	// engine.prep under exactOptionalPropertyTypes.
	sampleRateHz: number | undefined;
	mono: boolean | undefined;
}

// Extract the audio track and split into fixed-length chunks — one pass
// handles both "video whose audio fits" (one segment) and "genuinely
// long recording" (many). The keep profile ships mono 48k opus (a
// video note's payload is mostly pixels); the wav profile ships the
// engine's sample rate as pcm_s16le. Returns sorted chunk paths.
async function segmentAudio(
	src: string,
	dir: string,
	segmentSeconds: number,
	prep: PrepSpec,
): Promise<string[]> {
	const wav = prep.container === "wav";
	// wav: the local engine's contract — 16 kHz mono pcm_s16le. keep:
	// mono 48k opus, small enough that a 15-minute segment stays under
	// every cloud upload cap.
	const audio = wav
		? ["-ar", String(prep.sampleRateHz ?? 16_000), "-ac", prep.mono === false ? "2" : "1", "-c:a", "pcm_s16le"]
		: ["-ac", "1", "-b:a", "48k", "-c:a", "libopus"];
	const proc = spawnProc([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		src,
		"-vn",
		...audio,
		"-f",
		"segment",
		"-segment_time",
		String(segmentSeconds),
		"-reset_timestamps",
		"1",
		join(dir, wav ? "seg_%04d.wav" : "seg_%04d.ogg"),
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
	const ext = wav ? ".wav" : ".ogg";
	const segments = (await readdir(dir)).filter((f) => f.endsWith(ext)).sort();
	if (segments.length === 0) {
		throw new Error("ffmpeg produced no segments — no audio track?");
	}
	return segments.map((f) => join(dir, f));
}

async function transcribeOne(engine: SpeechEngine, file: SpeechFile): Promise<string | null> {
	const startedAt = Date.now();
	const result = await engine.transcribe(file);
	const text = result.text.trim();
	log.info("transcribed", {
		provider: engine.id,
		file: file.filename,
		path: file.path,
		chars: text.length,
		durationMs: Date.now() - startedAt,
		...(result.language ? { language: result.language } : {}),
	});
	return text === "" ? null : text;
}
