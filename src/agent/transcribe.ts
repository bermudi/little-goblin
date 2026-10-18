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
import type { Config, ConfigRef, TranscriptionConfig } from "../config.ts";
import { log } from "../log.ts";
import { boundedRun, spawnProc } from "../proc.ts";
import {
	elevenlabsEngine,
	geminiEngine,
	groqEngine,
	logfareEngine,
	mimoEngine,
	mistralEngine,
	openaiEngine,
	openrouterEngine,
} from "./transcribe-cloud.ts";
import { whistleArtifactPresence, whistleEngine } from "./transcribe-whistle.ts";

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
		case "whistle":
			return whistleEngine(cfg, deps);
		case "groq":
			return groqEngine(cfg, auth, deps);
		case "openai":
			return openaiEngine(cfg, auth, deps);
		case "openrouter":
			return openrouterEngine(cfg, auth, deps);
		case "mistral":
			return mistralEngine(cfg, auth, deps);
		case "elevenlabs":
			return elevenlabsEngine(cfg, auth, deps);
		case "gemini":
			return geminiEngine(cfg, auth, deps);
		case "mimo":
			return mimoEngine(cfg, auth, deps);
		case "logfare":
			return logfareEngine(cfg, auth, deps);
	}
}

// Boot probe for speech features that need ffmpeg on PATH. Resolves
// false when the binary is missing or broken — the caller decides what
// that costs (TTS takes the feature down for the run; transcription
// degrades per message: keep-profile engines only lose the over-cap
// path, wav-profile engines lose everything). The warn here is the
// audit trail either way.
export async function probeFfmpeg(
	feature = "transcription",
	requiredEncoder?: string,
): Promise<boolean> {
	try {
		const r = await boundedRun(spawnProc(["ffmpeg", "-version"]), {
			timeoutMs: 10_000,
			maxOutput: 8 * 1024,
		});
		if (r.exitCode !== 0) {
			throw new Error(`ffmpeg -version exited ${r.exitCode ?? "unreaped"}`);
		}
	} catch (err) {
		log.warn("ffmpeg unavailable", err, { feature });
		return false;
	}
	// Encoder presence: a minimal ffmpeg can run and still lack the
	// codec the feature encodes with (openrouter TTS needs libopus).
	if (requiredEncoder !== undefined) {
		const enc = await boundedRun(spawnProc(["ffmpeg", "-hide_banner", "-encoders"]), {
			timeoutMs: 10_000,
			maxOutput: 512 * 1024,
		});
		if (enc.exitCode !== 0 || !enc.stdout.includes(requiredEncoder)) {
			log.warn("ffmpeg lacks required encoder", {
				feature,
				encoder: requiredEncoder,
			});
			return false;
		}
	}
	return true;
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
		? [
				"-ar",
				String(prep.sampleRateHz ?? 16_000),
				"-ac",
				prep.mono === false ? "2" : "1",
				"-c:a",
				"pcm_s16le",
			]
		: ["-ac", "1", "-b:a", "48k", "-c:a", "libopus"];
	const proc = spawnProc([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		src,
		"-vn",
		// Browser MediaRecorder output (PWA voice notes: webm, ogg,
		// mp4) carries duration=N/A headers and packet timestamps that
		// don't map to wall time — the segment muxer then cuts one
		// ~60 ms segment per packet (153 segments from a 9 s note).
		// Rebuild pts from decoded sample count instead: contiguous
		// frames are true wall time regardless of container lies.
		"-af",
		"asetpts=N/SR/TB",
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

// The intake/tool call seam — reads the live config per call so a
// mini-app save applies to the next voice note; absent block answers
// null. boot() builds it once and hands the closure to makeTools.
export function makeTranscriber(deps: {
	configRef: ConfigRef;
	auth: AuthStore;
}): (file: SpeechFile) => Promise<string | null> {
	return (file) => {
		const cfg = deps.configRef.current.transcription;
		if (!cfg) return Promise.resolve(null);
		return transcribeAudio(speechEngine(cfg, deps.auth), file);
	};
}

// Boot-time media readiness: voice replies and transcription die at
// runtime without ffmpeg — probing costs ~30ms and saves a tool
// failing per message; transcription needs it only over the upload cap
// (for the wav-profile kinds, always — whistle's ogg→wav decode,
// mimo's wav-only input contract). Writes configRef.ttsDown when the
// probe fails on a configured tts block.
export async function checkBootMedia(config: Config, configRef: ConfigRef): Promise<void> {
	if (config.transcription || config.tts) {
		const wavKind =
			config.transcription?.kind === "whistle" || config.transcription?.kind === "mimo"
				? config.transcription.kind
				: undefined;
		const feature = config.tts
			? "tts"
			: wavKind !== undefined
				? `transcription (${wavKind})`
				: "transcription";
		// Edge's remux is a stream copy; the cloud kinds' mp3 must
		// re-encode to opus, so a binary without libopus would die per
		// chunk.
		const ok = await probeFfmpeg(
			feature,
			config.tts !== false && config.tts !== undefined && config.tts.kind !== "edge"
				? "libopus"
				: undefined,
		);
		if (!ok && config.tts) {
			configRef.ttsDown = true;
			log.warn(
				"tts disabled — ffmpeg not found on PATH; install ffmpeg and restart to enable voice replies",
			);
		}
	}
	if (config.transcription) {
		const tr = config.transcription;
		log.info("transcription enabled", {
			kind: tr.kind,
			...(tr.kind === "whistle" ? whistleArtifactPresence(tr) : { model: tr.model, auth: tr.auth }),
		});
	}
}
