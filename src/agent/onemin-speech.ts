// 1min.AI's /api door — one wire family for both speech directions.
// Chat rides the OpenAI-compatible door (onemin.ts owns those truths);
// this module owns the AI Feature API envelope
// (docs.1min.ai/docs/api → AI Feature API, Get Result API, Asset API):
//
//   POST https://api.1min.ai/api/features
//     API-KEY: <the same 1min key as the chat door, one auth record>
//     { type, model, promptObject }
//   → { aiRecord: { uuid, status, aiRecordDetail: { resultObject },
//                  temporaryUrl } }
//
// status may be PROCESSING — GET /api/results/{uuid} (same API-KEY
// header) polls until SUCCESS (Get Result API: "While Processing" /
// "When Complete"). On FAILURE the same envelope carries an error
// object as resultObject (Get Result API: code/name/message/traceId —
// "PIAPI_TASK_RESPONSE_ERROR" in their fixture) and an unknown uuid
// answers `{"aiRecord": null}` with HTTP 200 — both named loudly
// here, never misread as shape violations. File results download
// from the signed temporaryUrl — pre-signed S3, so the 1min key never
// rides that fetch; text results ARE the resultObject entries (the
// qwen3-asr-flash example carries the transcript itself, temporaryUrl
// ""). STT audio is uploaded first via POST /api/assets (multipart
// field "asset"), the returned fileContent.path feeding
// promptObject.audioUrl.
//
// The Feature API offers `"async": true` — answer PROCESSING at once,
// immune to the gateway's 524 on long processing (their own words:
// "A synchronous request can exceed the gateway timeout and fail with
// a 524 error even though processing continues on the server"). STT
// rides it: transcription is the slow feature and the poll loop
// already exists; TTS stays synchronous — chunks are ≤4k chars and
// every poll cycle would add latency to a voice reply. If live probing
// ever shows 524s on long TTS chunks, `async: true` is the documented
// fix on that door too.
//
// The TTS page's prose ("the response will be a binary audio stream")
// contradicts its own request/response example (JSON envelope +
// temporaryUrl) — the example is pinned here; it is what their cURL
// actually does.
//
// Doc-pinned, unverified live — no key provisioned yet (the asr.md
// doctrine: fixtures pin the documented shapes, the first live use is
// the probe). Resolved keys never enter logs.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AuthStore } from "../auth.ts";
import type { TranscriptionConfig, TtsConfig } from "../config.ts";
import { log } from "../log.ts";
import { readBytesCapped, readTextCapped } from "./tools/web.ts";
import { parseBody, renderError } from "./transcribe-cloud.ts";
import { timeoutMs as voiceLaneTimeout } from "./tts-cloud.ts";
import type { ChunkSynthesizer } from "./tts.ts";
import type { EngineDeps, EngineTranscript, SpeechEngine, SpeechFile } from "./transcribe.ts";

const FEATURES_URL = "https://api.1min.ai/api/features";
const RESULTS_URL = "https://api.1min.ai/api/results";
const ASSETS_URL = "https://api.1min.ai/api/assets";
// The envelope is small JSON; the audio download is bounded by the
// same 32 MiB the other cloud TTS engines accept.
const ENVELOPE_CAP = 1024 * 1024;
const AUDIO_CAP = 32 * 1024 * 1024;
// One budget per call: upload + feature + poll for STT, feature + poll
// + download for TTS — elevenlabs' 120 s transcription convention.
const STT_BUDGET_MS = 120_000;
// The Get Result API publishes no polling cadence — 2.5 s is a
// conservative default between polls (injectable so wire tests run
// fast; a wedged poll is still bounded by the budget's signal).
const POLL_INTERVAL_MS = 2_500;

export interface OneMinDeps {
	fetchFn?: typeof fetch | undefined;
	pollIntervalMs?: number | undefined;
}

export type OneMinTtsConfig = Extract<TtsConfig, { kind: "onemin" }>;
export type OneMinSttConfig = Extract<TranscriptionConfig, { kind: "onemin" }>;

// The aiRecord envelope both doors answer (docs → Get Result API;
// TEXT_TO_SPEECH and qwen3-asr-flash response examples). resultObject
// is a string array on SUCCESS (empty while PROCESSING) but an error
// OBJECT on FAILURE (code/name/message/traceId — Get Result API →
// resultObject Error Object); aiRecord is null when the uuid is
// unknown or belongs to another key (HTTP 200 — Get Result API →
// Not Found).
const recordEnvelope = z.object({
	aiRecord: z
		.object({
			uuid: z.string().min(1),
			status: z.string().min(1),
			aiRecordDetail: z
				.object({
					resultObject: z
						.union([z.array(z.string()), z.record(z.string(), z.unknown())])
						.optional(),
				})
				.optional(),
			temporaryUrl: z.string().optional(),
		})
		.nullable(),
});
type FeatureRecord = NonNullable<z.output<typeof recordEnvelope>["aiRecord"]>;

// The Asset API answer: fileContent.path is what promptObject.audioUrl
// takes (the whisper-1 example's "audios/…" is one); asset.key is the
// same path in the S3 record — first, second, fail loud.
const assetEnvelope = z.object({
	fileContent: z.object({ path: z.string().min(1) }).optional(),
	asset: z.object({ key: z.string().min(1) }).optional(),
});

// One deadline per call — every fetch races the same signal, so a
// wedged poll cannot outlive the engine's budget.
function budget(ms: number): { signal: AbortSignal; deadline: number; stop(): void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return {
		signal: controller.signal,
		deadline: Date.now() + ms,
		stop: () => clearTimeout(timer),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readEnvelope(kind: string, res: Response): Promise<FeatureRecord | null> {
	const { tooLarge, text } = await readTextCapped(res, ENVELOPE_CAP);
	if (tooLarge) throw new Error(`${kind}: response over ${ENVELOPE_CAP} bytes`);
	if (!res.ok) throw renderError(kind, res.status, text);
	return parseBody(kind, text, recordEnvelope).aiRecord;
}

// POST /api/features, polling GET /api/results/{uuid} while the record
// is PROCESSING (docs → Get Result API: empty resultObject while
// processing; SUCCESS is the settled answer, any other status is a
// failure to name, not to guess at).
async function callFeature(
	key: string,
	call: { type: string; model: string; [k: string]: unknown },
	b: { signal: AbortSignal; deadline: number },
	fetchFn: typeof fetch,
	pollIntervalMs: number,
): Promise<FeatureRecord> {
	async function post(): Promise<Response> {
		try {
			return await fetchFn(FEATURES_URL, {
				method: "POST",
				headers: { "API-KEY": key, "content-type": "application/json" },
				body: JSON.stringify(call),
				signal: b.signal,
			});
		} catch (err) {
			throw new Error(`onemin: request failed (${FEATURES_URL}) — ${(err as Error).message}`);
		}
	}
	let record = await readEnvelope("onemin", await post());
	if (record === null) {
		throw new Error("onemin: no record in response — aiRecord is null");
	}
	while (record.status === "PROCESSING") {
		const remaining = b.deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(
				`onemin: ${call.type} still PROCESSING after the call budget (uuid ${record.uuid})`,
			);
		}
		await sleep(Math.min(pollIntervalMs, remaining));
		const uuid = record.uuid;
		try {
			const polled = await readEnvelope(
				"onemin",
				await fetchFn(`${RESULTS_URL}/${encodeURIComponent(uuid)}`, {
					headers: { "API-KEY": key },
					signal: b.signal,
				}),
			);
			if (polled === null) {
				// Get Result API → Not Found: HTTP 200 with aiRecord null
				// — the uuid is unknown, deleted, expired, or belongs to
				// another team's key. Name it; do not pretend a shape broke.
				throw new Error(
					`onemin: no such result record (uuid ${uuid}) — deleted, expired, or another key's record`,
				);
			}
			record = polled;
		} catch (err) {
			throw new Error(`onemin: result poll failed (uuid ${uuid}) — ${(err as Error).message}`);
		}
	}
	if (record.status !== "SUCCESS") {
		// FAILURE carries the error object in resultObject (Get Result
		// API → resultObject Error Object): surface its message and
		// code rather than burying them; a status string without one
		// still fails loud by name.
		const failure = record.aiRecordDetail?.resultObject;
		if (failure !== undefined && !Array.isArray(failure)) {
			const message =
				typeof failure.message === "string" ? failure.message : JSON.stringify(failure);
			const code = typeof failure.code === "string" ? ` (${failure.code})` : "";
			throw new Error(
				`onemin: ${call.type} failed (status "${record.status}")${code}: ${message} (uuid ${record.uuid})`,
			);
		}
		throw new Error(
			`onemin: ${call.type} ended with status "${record.status}" (uuid ${record.uuid})`,
		);
	}
	return record;
}

// POST /api/assets — multipart field "asset" (docs → Asset API); the
// storage path it answers feeds promptObject.audioUrl.
async function uploadAsset(
	key: string,
	file: SpeechFile,
	budget: { signal: AbortSignal },
	fetchFn: typeof fetch,
): Promise<string> {
	const form = new FormData();
	form.append(
		"asset",
		new Blob([await readFile(file.path)], { type: file.mediaType }),
		file.filename,
	);
	let res: Response;
	try {
		res = await fetchFn(ASSETS_URL, {
			method: "POST",
			headers: { "API-KEY": key },
			body: form,
			signal: budget.signal,
		});
	} catch (err) {
		throw new Error(`onemin: asset upload failed (${ASSETS_URL}) — ${(err as Error).message}`);
	}
	const { tooLarge, text } = await readTextCapped(res, ENVELOPE_CAP);
	if (tooLarge) throw new Error(`onemin: asset response over ${ENVELOPE_CAP} bytes`);
	if (!res.ok) throw renderError("onemin", res.status, text);
	const parsed = parseBody("onemin", text, assetEnvelope);
	const path = parsed.fileContent?.path ?? parsed.asset?.key;
	if (path === undefined) {
		throw new Error("onemin: asset upload response carries no storage path");
	}
	log.debug("onemin asset uploaded", { file: file.filename, path });
	return path;
}

// ---------- text to speech (TEXT_TO_SPEECH) ----------

export function oneminSpeech(
	cfg: OneMinTtsConfig,
	auth: AuthStore,
	deps: OneMinDeps = {},
): ChunkSynthesizer {
	const fetchFn = deps.fetchFn ?? fetch;
	const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
	return async (text, options) => {
		const key = await auth.resolve(cfg.auth);
		const b = budget(voiceLaneTimeout(text.length));
		try {
			const record = await callFeature(
				key,
				{
					type: "TEXT_TO_SPEECH",
					model: cfg.model,
					// The documented request example carries the feature
					// name as the conversationId (docs → OpenAI
					// Text-to-Speech → Request Example).
					conversationId: "TEXT_TO_SPEECH",
					promptObject: {
						text,
						// voice is required on this wire — the schema
						// materializes one, but never send a blank.
						voice: options.voice !== "" ? options.voice : "alloy",
						response_format: options.outputFormat,
					},
				},
				b,
				fetchFn,
				pollIntervalMs,
			);
			const url = record.temporaryUrl;
			if (url === undefined || url === "") {
				throw new Error("onemin: no audio URL in response — temporaryUrl missing");
			}
			// The signed URL carries its own authorization — the 1min
			// key must never ride a fetch to a foreign host.
			let res: Response;
			try {
				res = await fetchFn(url, { signal: b.signal });
			} catch (err) {
				throw new Error(`onemin: audio download failed — ${(err as Error).message}`);
			}
			if (!res.ok) {
				const { text: body } = await readTextCapped(res, ENVELOPE_CAP);
				throw renderError("onemin", res.status, body);
			}
			const { tooLarge, bytes } = await readBytesCapped(res, AUDIO_CAP);
			if (tooLarge) throw new Error(`onemin: audio response over ${AUDIO_CAP} bytes`);
			if (bytes.byteLength === 0) throw new Error("onemin: empty audio response");
			log.debug("onemin speech chunk synthesized", {
				model: cfg.model,
				chars: text.length,
				bytes: bytes.byteLength,
			});
			return bytes;
		} finally {
			b.stop();
		}
	};
}

// ---------- speech to text (SPEECH_TO_TEXT) ----------

// whisper-1 answers a response_format; the rest of the family takes
// the audio path alone. language is documented on every STT page in
// the catalog (whisper-1: ISO 639-1; qwen3-asr-flash: its Language
// Options table incl. yue/fil; elevenlabs: its Language Support
// section, though its example payload omits it; latest_short/
// latest_long + the phone/telephony/medical models: REQUIRED, the
// xx-YY locale form) — so it rides whenever the operator set one; a
// model that requires it and doesn't get one fails loud upstream
// rather than being faked here.
function sttPromptObject(
	model: string,
	audioUrl: string,
	language: string | undefined,
): Record<string, unknown> {
	const lang = language === undefined ? {} : { language };
	if (model === "whisper-1") {
		return { audioUrl, response_format: "text", ...lang };
	}
	return { audioUrl, ...lang };
}

// qwen3-asr-flash's format table is the one without MP4 (aac, amr,
// avi, aiff, flac, flv, m4a, mkv, mp3, mpeg, ogg, opus, wav, webm,
// wma, wmv — docs → qwen3-asr-flash → Supported formats) — Telegram
// video notes arrive as .mp4, so qwen3 rides the wav profile (16 kHz
// mono pcm_s16le, on every documented model's list) instead of the
// native-container keep. Every other STT model's table lists both
// OGG (voice notes) and MP4, so they keep native containers and only
// segment over the cap.
const QWEN3_ASR = "qwen3-asr-flash";
// 16 kHz mono 16-bit wav ≈ 32 kB/s: 280 s ≈ 9 MB, under qwen3's 10 MB
// cap with margin — wav segments are sized by duration (mimo's 180 s
// precedent), and there is no maxBytes knob on this profile.
const QWEN_WAV_SEGMENT_SECONDS = 280;

export function oneminEngine(
	cfg: OneMinSttConfig,
	auth: AuthStore,
	deps: EngineDeps & { pollIntervalMs?: number | undefined } = {},
): SpeechEngine {
	const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
	// qwen3-asr-flash documents a 10 MB cap — the tightest published
	// ceiling in the family (whisper-1's page says ~25 MB effective,
	// the Asset API takes 50 MB uploads), so every keep-profile
	// request segments under it; the wav profile's duration sizing is
	// what actually bounds qwen3's segments.
	const qwen = cfg.model === QWEN3_ASR;
	return {
		id: `onemin/${cfg.model}`,
		limits: qwen
			? { maxSeconds: QWEN_WAV_SEGMENT_SECONDS }
			: { maxBytes: 10 * 1024 * 1024, maxSeconds: 15 * 60 },
		prep: qwen ? { container: "wav", sampleRateHz: 16_000, mono: true } : { container: "keep" },
		transcribe: async (file): Promise<EngineTranscript> => {
			const key = await auth.resolve(cfg.auth);
			const fetchFn = deps.fetchFn ?? fetch;
			const b = budget(STT_BUDGET_MS);
			try {
				const audioUrl = await uploadAsset(key, file, b, fetchFn);
				const record = await callFeature(
					key,
					{
						type: "SPEECH_TO_TEXT",
						model: cfg.model,
						// The async door — PROCESSING at once, then poll; immune
						// to the gateway's 524 on long audio (docs → AI Feature
						// API → Async Requests).
						async: true,
						promptObject: sttPromptObject(cfg.model, audioUrl, cfg.language),
					},
					b,
					fetchFn,
					pollIntervalMs,
				);
				// The transcript is the resultObject entry itself (the
				// qwen3-asr-flash example — the only STT response example
				// in the docs, so the same shape is the working assumption
				// for the whole family). An EMPTY array is the
				// orchestrator's "no speech" null; a missing or
				// object-shaped resultObject on SUCCESS is contract
				// drift — "" would read as silence, so it names itself.
				const results = record.aiRecordDetail?.resultObject;
				if (!Array.isArray(results)) {
					throw new Error(
						`onemin: SUCCESS without a resultObject array (uuid ${record.uuid})`,
					);
				}
				const text = results[0] ?? "";
				log.debug("onemin transcription complete", {
					model: cfg.model,
					file: file.filename,
					chars: text.length,
				});
				return { text };
			} finally {
				b.stop();
			}
		},
	};
}
