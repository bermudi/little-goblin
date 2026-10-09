// Cloud speech engines — hand-rolled HTTP like TTS (tts.ts), no
// provider SDK. Two adapter families (design/asr.md):
//
//   OpenAI-compatible multipart — groq, openai, mistral: one
//     implementation, three URLs, {"text": …} back.
//   Bespoke — elevenlabs (multipart, xi-api-key), openrouter (JSON
//     base64 STT), gemini + mimo (chat-with-audio by instruction).
//
// Response and error shapes are pinned verbatim in transcribe-cloud
// .test.ts (probed live 2026-10-09/10 — design/asr.md → Verbatim
// contracts; openrouter-ogg and mimo verified live during
// implementation). Resolved keys never enter logs.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AuthStore } from "../auth.ts";
import type { TranscriptionConfig } from "../config.ts";
import { log } from "../log.ts";
import { boundedRun, spawnProc } from "../proc.ts";
import { readTextCapped } from "./tools/web.ts";
import type { EngineDeps, EngineTranscript, SpeechEngine, SpeechFile } from "./transcribe.ts";

// Every cloud arm of the transcription union — one shape (kind, model,
// auth, language?), seven kinds.
export type CloudCfg = Extract<
	TranscriptionConfig,
	{ kind: "groq" | "openai" | "openrouter" | "mistral" | "elevenlabs" | "gemini" | "mimo" }
>;

// Groq's multipart cap is 25 MiB — over that, segment instead of
// guessing at a request that 413s anyway.
const MULTIPART_MAX_BYTES = 25 * 1024 * 1024;
// 15 minutes of 48k mono opus ≈ 5.5 MiB — comfortably under the cap no
// matter the source bitrate.
const MULTIPART_SEGMENT_SECONDS = 15 * 60;
const MULTIPART_TIMEOUT_MS = 60_000;
// Chat-family engines inline the audio as base64 (+33%) — cap lower so
// the inflated body stays inside the provider's request budget
// (gemini's inlineData ceiling is ≈ 20 MB total).
const CHAT_MAX_BYTES = 12 * 1024 * 1024;
const CHAT_SEGMENT_SECONDS = 10 * 60;
const CHAT_TIMEOUT_MS = 120_000;
// ElevenLabs quotes up to ~40 s processing on long inputs.
const ELEVENLABS_TIMEOUT_MS = 120_000;
// OpenRouter warns of ~60 s upstream processing per STT request.
const OPENROUTER_TIMEOUT_MS = 120_000;
// A transcript scales with input length; a misbehaving gateway must not
// stream gigabytes into memory.
const RESPONSE_CAP = 8 * 1024 * 1024;
const ERROR_HEAD = 300;
const CHAT_OUTPUT_TOKEN_CAP = 8192;
const TRANSCRIBE_PROMPT =
	"Transcribe the audio verbatim. Output only the transcript, no commentary. If there is no speech, output nothing.";

// {"text": …} — the minimal shape every OpenAI-compatible endpoint
// returns without response_format=verbose_json. Language/duration only
// exist in verbose responses (groq's is full words, not codes) —
// present means logged, never interpreted.
const multipartResponse = z.object({
	text: z.string(),
	language: z.string().optional(),
});

const elevenlabsResponse = z.object({
	text: z.string(),
	language_code: z.string().optional(),
});

const openrouterResponse = z.object({
	text: z.string(),
	usage: z.object({ seconds: z.number().optional(), cost: z.number().optional() }).optional(),
});

const geminiResponse = z.object({
	candidates: z
		.array(
			z.object({
				content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }).optional(),
				finishReason: z.string().optional(),
			}),
		)
		.min(1),
});

const chatResponse = z.object({
	choices: z
		.array(
			z.object({
				message: z.object({ content: z.string() }),
				finish_reason: z.string().optional(),
			}),
		)
		.min(1),
	usage: z.object({ cost: z.number().optional() }).optional(),
});

// ---------- OpenAI-compatible multipart ----------

export function groqEngine(cfg: CloudCfg, auth: AuthStore, deps: EngineDeps = {}): SpeechEngine {
	return openAiCompatible(
		"groq",
		cfg,
		auth,
		"https://api.groq.com/openai/v1/audio/transcriptions",
		deps,
	);
}

export function openaiEngine(cfg: CloudCfg, auth: AuthStore, deps: EngineDeps = {}): SpeechEngine {
	return openAiCompatible(
		"openai",
		cfg,
		auth,
		"https://api.openai.com/v1/audio/transcriptions",
		deps,
	);
}

export function mistralEngine(cfg: CloudCfg, auth: AuthStore, deps: EngineDeps = {}): SpeechEngine {
	return openAiCompatible(
		"mistral",
		cfg,
		auth,
		"https://api.mistral.ai/v1/audio/transcriptions",
		deps,
	);
}

// groq/openai/mistral share one wire: multipart file+model(+language),
// Bearer auth, {"text": …} back. Differences are the URL and the error
// body flavor, both handled in renderError.
function openAiCompatible(
	kind: string,
	cfg: CloudCfg,
	authStore: AuthStore,
	url: string,
	deps: EngineDeps,
): SpeechEngine {
	return {
		id: `${kind}/${cfg.model}`,
		limits: { maxBytes: MULTIPART_MAX_BYTES, maxSeconds: MULTIPART_SEGMENT_SECONDS },
		prep: { container: "keep" },
		transcribe: async (file): Promise<EngineTranscript> => {
			const key = await authStore.resolve(cfg.auth);
			const form = new FormData();
			form.append(
				"file",
				new Blob([await readFile(file.path)], { type: file.mediaType }),
				file.filename,
			);
			form.append("model", cfg.model);
			if (cfg.language !== undefined) form.append("language", cfg.language);
			const res = await httpPost(kind, url, {
				headers: { authorization: `Bearer ${key}` },
				body: form,
				deps,
				timeoutMs: MULTIPART_TIMEOUT_MS,
			});
			const { tooLarge, text } = await readTextCapped(res, RESPONSE_CAP);
			if (tooLarge) throw new Error(`${kind}: response over ${RESPONSE_CAP} bytes`);
			if (!res.ok) throw renderError(kind, res.status, text);
			return parseBody(kind, text, multipartResponse);
		},
	};
}

// ---------- elevenlabs ----------

export function elevenlabsEngine(
	cfg: CloudCfg,
	auth: AuthStore,
	deps: EngineDeps = {},
): SpeechEngine {
	return {
		id: `elevenlabs/${cfg.model}`,
		limits: { maxBytes: MULTIPART_MAX_BYTES, maxSeconds: MULTIPART_SEGMENT_SECONDS },
		prep: { container: "keep" },
		transcribe: async (file): Promise<EngineTranscript> => {
			const key = await auth.resolve(cfg.auth);
			const form = new FormData();
			form.append(
				"file",
				new Blob([await readFile(file.path)], { type: file.mediaType }),
				file.filename,
			);
			form.append("model_id", cfg.model);
			if (cfg.language !== undefined) form.append("language_code", cfg.language);
			const res = await httpPost("elevenlabs", "https://api.elevenlabs.io/v1/speech-to-text", {
				headers: { "xi-api-key": key },
				body: form,
				deps,
				timeoutMs: ELEVENLABS_TIMEOUT_MS,
			});
			const { tooLarge, text } = await readTextCapped(res, RESPONSE_CAP);
			if (tooLarge) throw new Error(`elevenlabs: response over ${RESPONSE_CAP} bytes`);
			if (!res.ok) throw renderError("elevenlabs", res.status, text);
			const parsed = parseBody("elevenlabs", text, elevenlabsResponse);
			return {
				text: parsed.text,
				...(parsed.language_code !== undefined ? { language: parsed.language_code } : {}),
			};
		},
	};
}

// ---------- openrouter (JSON STT + chat) ----------

// OpenRouter's input_audio takes these formats (wav + ogg probed live,
// mp3 documented). Anything else — video notes arrive as .mp4 — is
// ffmpeg-extracted to opus-in-ogg below instead of failing on the
// container: the audio track is what the provider needs.
const AUDIO_FORMATS: Record<string, string> = {
	".wav": "wav",
	".mp3": "mp3",
	".ogg": "ogg",
	".oga": "ogg",
};

function supportedFormat(filename: string): string | undefined {
	const dot = filename.lastIndexOf(".");
	const ext = dot === -1 ? "" : filename.slice(dot).toLowerCase();
	return AUDIO_FORMATS[ext];
}

// Single-file extraction budget — even a 15-minute note transcodes in seconds.
const AUDIO_EXTRACT_TIMEOUT_MS = 60_000;

interface PreparedAudio {
	path: string;
	format: string;
	cleanup: () => Promise<void>;
}

// The bytes ready for input_audio: the original file when its extension
// maps, else an ffmpeg audio-track extraction to mono 48k opus (the keep
// profile's segment codec in transcribe.ts). Transcode failures throw
// with the provider's name — callers run cleanup in a finally.
async function preparedInputAudio(kind: string, file: SpeechFile): Promise<PreparedAudio> {
	const direct = supportedFormat(file.filename);
	if (direct !== undefined) return { path: file.path, format: direct, cleanup: async () => {} };
	const dir = await mkdtemp(join(tmpdir(), "goblin-au-"));
	const out = join(dir, "audio.ogg");
	const cleanup = async (): Promise<void> => {
		await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
			log.warn("transcription audio extract cleanup failed", err, { dir });
		});
	};
	let proc: ReturnType<typeof spawnProc>;
	try {
		proc = spawnProc([
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			file.path,
			"-vn",
			"-ac",
			"1",
			"-b:a",
			"48k",
			"-c:a",
			"libopus",
			out,
		]);
	} catch (err) {
		await cleanup();
		throw new Error(
			`${kind}: audio extraction failed for "${file.filename}" — ffmpeg failed to spawn: ${(err as Error).message}`,
		);
	}
	const r = await boundedRun(proc, {
		timeoutMs: AUDIO_EXTRACT_TIMEOUT_MS,
		maxOutput: 64 * 1024,
	});
	if (r.timedOut) {
		await cleanup();
		throw new Error(
			`${kind}: audio extraction timed out after ${AUDIO_EXTRACT_TIMEOUT_MS}ms for "${file.filename}"`,
		);
	}
	if (r.exitCode !== 0) {
		await cleanup();
		throw new Error(
			`${kind}: audio extraction failed for "${file.filename}" — ffmpeg exited ${r.exitCode ?? "unreaped"}: ${r.stderr.trim().slice(0, 300)}`,
		);
	}
	log.info("transcription audio extracted", { engine: kind, file: file.filename });
	return { path: out, format: "ogg", cleanup };
}

async function base64Audio(path: string): Promise<string> {
	return Buffer.from(await readFile(path)).toString("base64");
}

function logUsage(
	id: string,
	usage: { seconds?: number | undefined; cost?: number | undefined } | undefined,
): void {
	if (usage === undefined) return;
	log.info("transcription usage", {
		engine: id,
		...(usage.seconds !== undefined ? { seconds: usage.seconds } : {}),
		...(usage.cost !== undefined ? { cost: usage.cost } : {}),
	});
}

export function openrouterEngine(
	cfg: CloudCfg,
	auth: AuthStore,
	deps: EngineDeps = {},
): SpeechEngine {
	return {
		id: `openrouter/${cfg.model}`,
		limits: { maxBytes: MULTIPART_MAX_BYTES, maxSeconds: MULTIPART_SEGMENT_SECONDS },
		prep: { container: "keep" },
		transcribe: async (file): Promise<EngineTranscript> => {
			const key = await auth.resolve(cfg.auth);
			// Resolve the extension first so a transcode failure is a
			// context-carrying error, not cleanup noise.
			const prepared = await preparedInputAudio("openrouter", file);
			try {
				const res = await httpPost(
					"openrouter",
					"https://openrouter.ai/api/v1/audio/transcriptions",
					{
						headers: {
							authorization: `Bearer ${key}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({
							model: cfg.model,
							input_audio: {
								data: await base64Audio(prepared.path),
								format: prepared.format,
							},
						}),
						deps,
						timeoutMs: OPENROUTER_TIMEOUT_MS,
					},
				);
				const { tooLarge, text } = await readTextCapped(res, RESPONSE_CAP);
				if (tooLarge) throw new Error(`openrouter: response over ${RESPONSE_CAP} bytes`);
				if (!res.ok) throw renderError("openrouter", res.status, text);
				const parsed = parseBody("openrouter", text, openrouterResponse);
				logUsage(`openrouter/${cfg.model}`, parsed.usage);
				return { text: parsed.text };
			} finally {
				await prepared.cleanup();
			}
		},
	};
}

// ---------- chat-with-audio (gemini, mimo) ----------

export function geminiEngine(cfg: CloudCfg, auth: AuthStore, deps: EngineDeps = {}): SpeechEngine {
	return {
		id: `gemini/${cfg.model}`,
		limits: { maxBytes: CHAT_MAX_BYTES, maxSeconds: CHAT_SEGMENT_SECONDS },
		prep: { container: "keep" },
		transcribe: async (file): Promise<EngineTranscript> => {
			const key = await auth.resolve(cfg.auth);
			const res = await httpPost(
				"gemini",
				`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`,
				{
					headers: { "x-goog-api-key": key, "content-type": "application/json" },
					body: JSON.stringify({
						contents: [
							{
								role: "user",
								parts: [
									{
										inlineData: {
											mimeType: file.mediaType,
											data: await base64Audio(file.path),
										},
									},
									{ text: TRANSCRIBE_PROMPT },
								],
							},
						],
						generationConfig: { temperature: 0, maxOutputTokens: CHAT_OUTPUT_TOKEN_CAP },
					}),
					deps,
					timeoutMs: CHAT_TIMEOUT_MS,
				},
			);
			const { tooLarge, text } = await readTextCapped(res, RESPONSE_CAP);
			if (tooLarge) throw new Error(`gemini: response over ${RESPONSE_CAP} bytes`);
			if (!res.ok) throw renderError("gemini", res.status, text);
			const parsed = parseBody("gemini", text, geminiResponse);
			const cand = parsed.candidates[0];
			if (cand === undefined) throw new Error("gemini: unexpected response shape — no candidates");
			const transcript = (cand.content?.parts ?? [])
				.map((p) => p.text ?? "")
				.join("")
				.trim();
			if (transcript === "" && cand.finishReason !== undefined && cand.finishReason !== "STOP") {
				// A refusal or safety block must not read as silence (#101).
				throw new Error(`gemini: no transcript — finishReason ${cand.finishReason}`);
			}
			if (cand.finishReason === "MAX_TOKENS") {
				log.warn("transcription hit the chat output cap — transcript is truncated", {
					engine: `gemini/${cfg.model}`,
					file: file.filename,
				});
			}
			return { text: transcript };
		},
	};
}

// mimo rides OpenRouter's chat completions with inline audio — Xiaomi
// serves the model there; there is no first-party API.
export function mimoEngine(cfg: CloudCfg, auth: AuthStore, deps: EngineDeps = {}): SpeechEngine {
	return {
		id: `mimo/${cfg.model}`,
		limits: { maxBytes: CHAT_MAX_BYTES, maxSeconds: CHAT_SEGMENT_SECONDS },
		prep: { container: "keep" },
		transcribe: async (file): Promise<EngineTranscript> => {
			const key = await auth.resolve(cfg.auth);
			const prepared = await preparedInputAudio("mimo", file);
			try {
				const res = await httpPost("mimo", "https://openrouter.ai/api/v1/chat/completions", {
					headers: {
						authorization: `Bearer ${key}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						model: cfg.model,
						temperature: 0,
						max_tokens: CHAT_OUTPUT_TOKEN_CAP,
						messages: [
							{
								role: "user",
								content: [
									{
										type: "input_audio",
										input_audio: {
											data: await base64Audio(prepared.path),
											format: prepared.format,
										},
									},
									{ type: "text", text: TRANSCRIBE_PROMPT },
								],
							},
						],
					}),
					deps,
					timeoutMs: CHAT_TIMEOUT_MS,
				});
				const { tooLarge, text } = await readTextCapped(res, RESPONSE_CAP);
				if (tooLarge) throw new Error(`mimo: response over ${RESPONSE_CAP} bytes`);
				if (!res.ok) throw renderError("mimo", res.status, text);
				const parsed = parseBody("mimo", text, chatResponse);
				const choice = parsed.choices[0];
				if (choice === undefined)
					throw new Error("mimo: unexpected response shape — no choices");
				if (choice.finish_reason === "length") {
					log.warn("transcription hit the chat output cap — transcript is truncated", {
						engine: `mimo/${cfg.model}`,
						file: file.filename,
					});
				}
				logUsage(`mimo/${cfg.model}`, parsed.usage);
				return { text: choice.message.content.trim() };
			} finally {
				await prepared.cleanup();
			}
		},
	};
}

// ---------- shared ----------

// Shared POST for every cloud kind: timeout, network-error naming, and
// status passthrough (callers render the error body). The URL never
// contains credentials — keys ride headers, never query strings.
async function httpPost(
	kind: string,
	url: string,
	init: {
		headers: Record<string, string>;
		body: FormData | string;
		deps: EngineDeps;
		timeoutMs: number;
	},
): Promise<Response> {
	const fetchFn = init.deps.fetchFn ?? fetch;
	try {
		return await fetchFn(url, {
			method: "POST",
			headers: init.headers,
			body: init.body,
			signal: AbortSignal.timeout(init.timeoutMs),
		});
	} catch (err) {
		throw new Error(`${kind}: request failed (${url}) — ${(err as Error).message}`);
	}
}

// groq/openai answer {"error":{"message":…}}; mistral is FastAPI-shaped
// with {"detail": …} (string or validation array). Anything else falls
// back to a body head.
export function renderError(kind: string, status: number, body: string): Error {
	let message = "";
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed === "object" && parsed !== null) {
			const { error, detail } = parsed as { error?: unknown; detail?: unknown };
			if (typeof error === "object" && error !== null) {
				const { message: m } = error as { message?: unknown };
				if (typeof m === "string") message = m;
			}
			if (message === "" && typeof detail === "string") message = detail;
			if (message === "" && Array.isArray(detail)) {
				message = JSON.stringify(detail).slice(0, ERROR_HEAD);
			}
		}
	} catch {
		// Not JSON — the raw head below is the honest message.
	}
	if (message === "") message = body.replace(/\s+/g, " ").trim().slice(0, ERROR_HEAD);
	return new Error(`${kind}: HTTP ${status} — ${message}`);
}

function parseBody<T extends z.ZodTypeAny>(kind: string, body: string, schema: T): z.output<T> {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		throw new Error(
			`${kind}: response is not JSON — ${body.replace(/\s+/g, " ").trim().slice(0, ERROR_HEAD)}`,
		);
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		throw new Error(
			`${kind}: unexpected response shape — ${body.replace(/\s+/g, " ").trim().slice(0, ERROR_HEAD)}`,
		);
	}
	return parsed.data;
}
