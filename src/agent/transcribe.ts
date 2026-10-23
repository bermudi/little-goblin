// Intake transcribes voice/video notes eagerly — the media kinds
// Telegram only produces by recording speech — and the transcript rides
// inside the data-attachment part, which materialization prefers over
// the bare path for models that can't consume audio (or payloads over
// the inline cap). Attached audio files transcribe on demand via the
// transcribe tool. Engines hand-roll HTTP — no provider SDKs; the
// orchestrator owns segmentation, silence semantics, and the log line.

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStore } from "../auth.ts";
import type { Config, ConfigRef, TranscriptionConfig } from "../config.ts";
import { log } from "../log.ts";
import { boundedRun, spawnProc } from "../proc.ts";
import { oneminEngine } from "./onemin-speech.ts";
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

// ≈1 h 52 m at the whistle profile's 28 s — past it, fail loud instead
// of grinding CPU for an afternoon.
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

export interface SpeechEngine {
	id: string;
	// Upload cap for keep-profile engines; per-segment ceiling both
	// profiles segment at.
	limits: { maxBytes?: number; maxSeconds?: number };
	// keep: original bytes under the cap, ffmpeg segmentation over it.
	// wav: always segment, shaped by sampleRateHz/mono (whistle: 16 kHz mono).
	prep: { container: "keep" | "wav"; sampleRateHz?: number; mono?: boolean };
	transcribe(file: SpeechFile): Promise<EngineTranscript>;
}

export interface EngineDeps {
	fetchFn?: typeof fetch;
}

// Auth resolves lazily at the point of use — the resolved key never
// leaves the engine.
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
		case "onemin":
			return oneminEngine(cfg, auth, deps);
	}
}

// false when ffmpeg is missing or broken — the caller decides the cost
// (TTS takes the feature down for the run; transcription degrades per
// message: keep-profile engines lose only the over-cap path, wav-profile
// engines lose everything).
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
	// A minimal ffmpeg can run and still lack the codec the feature
	// encodes with (openrouter TTS needs libopus).
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
	maxBytes?: number;
	segmentSeconds?: number;
}

// null = no speech found. Failures propagate instead — a failure must
// never read as silence (the intake caller degrades them to a warn +
// path-referenced attachment).
export async function transcribeAudio(
	engine: SpeechEngine,
	file: SpeechFile,
	opts: TranscribeOptions = {},
): Promise<string | null> {
	const maxBytes = opts.maxBytes ?? engine.limits.maxBytes;
	const segmentSeconds = opts.segmentSeconds ?? engine.limits.maxSeconds;
	if (engine.prep.container === "wav") {
		// The wav profile always transcodes — the local engine only eats
		// 16 kHz mono RIFF.
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
					// Extension-derived mime — only multipart engines consume it.
					mediaType: seg.endsWith(".wav") ? "audio/wav" : "audio/ogg",
					filename: seg,
				});
				if (t !== null) texts.push(t);
			} catch (err) {
				// A partial transcript beats a bare path.
				log.warn("transcription segment failed — result is partial", err, {
					file: file.filename,
					segment: seg,
				});
				// No partial to keep: null would read as "no speech" —
				// the provider error must name itself.
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
	// Explicit undefined — forwarded from engine.prep under
	// exactOptionalPropertyTypes.
	sampleRateHz: number | undefined;
	mono: boolean | undefined;
}

// keep ships mono 48k opus (a video note's payload is mostly pixels);
// wav ships the engine's sample rate as pcm_s16le.
async function segmentAudio(
	src: string,
	dir: string,
	segmentSeconds: number,
	prep: PrepSpec,
): Promise<string[]> {
	const wav = prep.container === "wav";
	// wav = the local engine's contract (16 kHz mono pcm_s16le); keep =
	// mono 48k opus, sized so a 15-min segment stays under every cloud cap.
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
		// MediaRecorder output carries duration=N/A headers and packet
		// pts that don't map to wall time — the segment muxer would cut
		// one ~60 ms segment per packet (a 9 s note → 153 segments).
		// Rebuild pts from decoded sample count: contiguous frames are
		// true wall time regardless of container lies.
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

// Engines run in order, a throw advances to the next. null ("no
// speech") is a successful answer from the engine that produced it,
// never a retry trigger. A whole failed chain throws one error naming
// each engine, bounded per link.
export async function transcribeChain(
	engines: SpeechEngine[],
	file: SpeechFile,
	opts: TranscribeOptions = {},
): Promise<string | null> {
	if (engines.length === 0) return null;
	if (engines.length === 1) {
		return transcribeAudio(engines[0]!, file, opts);
	}
	const errors: string[] = [];
	for (const [i, engine] of engines.entries()) {
		try {
			return await transcribeAudio(engine, file, opts);
		} catch (err) {
			errors.push(
				`${engine.id}: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
			);
			const next = engines[i + 1];
			if (next !== undefined) {
				log.warn("transcription failed — trying fallback", err, {
					engine: engine.id,
					next: next.id,
				});
			}
		}
	}
	throw new Error(errors.join(" | "));
}

// Live config read per call so a mini-app save applies to the next
// note; absent block answers null. `fallbacks` run in order after the
// block's own kind — whistle-last is the free safety net, cloud kinds
// bill per call.
export function makeTranscriber(deps: {
	configRef: ConfigRef;
	auth: AuthStore;
}): (file: SpeechFile) => Promise<string | null> {
	return (file) => {
		const cfg = deps.configRef.current.transcription;
		if (!cfg) return Promise.resolve(null);
		return transcribeChain(
			[cfg, ...(cfg.fallbacks ?? [])].map((e) => speechEngine(e, deps.auth)),
			file,
		);
	};
}

// Voice replies and transcription die at runtime without ffmpeg;
// transcription needs it only over the upload cap — except wav-profile
// engines (whistle's ogg→wav decode, mimo's wav-only input, onemin's
// qwen3 transcode), which need it always. Probe failure on a configured
// tts block writes configRef.ttsDown.
export async function checkBootMedia(
	config: Config,
	configRef: ConfigRef,
	auth: AuthStore,
): Promise<void> {
	if (config.transcription || config.tts) {
		const chain = [config.transcription, ...(config.transcription?.fallbacks ?? [])].filter(
			(c) => c !== undefined,
		);
		// prep.container is the wav truth — kind-keying can't see
		// onemin's per-model split. Descriptors cost nothing: engines
		// resolve auth lazily inside transcribe, never at build.
		const wav = chain.map((c) => speechEngine(c, auth)).find((e) => e.prep.container === "wav");
		const feature = config.tts
			? "tts"
			: wav !== undefined
				? `transcription (${wav.id})`
				: "transcription";
		// Edge's remux is a stream copy; cloud kinds' mp3 must re-encode
		// to opus — a libopus-less binary would die per chunk.
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
		const whistle = [tr, ...(tr.fallbacks ?? [])].find((e) => e.kind === "whistle");
		log.info("transcription enabled", {
			kind: tr.kind,
			...(tr.kind === "whistle" ? whistleArtifactPresence(tr) : { model: tr.model, auth: tr.auth }),
			...(tr.fallbacks?.length ? { fallbacks: tr.fallbacks.map((f) => f.kind) } : {}),
			// A whistle fallback's artifacts matter too — first real use
			// hits the digest-pinned fetch.
			...(whistle !== undefined && tr.kind !== "whistle"
				? { whistle: whistleArtifactPresence(whistle) }
				: {}),
		});
	}
}
