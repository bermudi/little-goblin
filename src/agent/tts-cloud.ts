// Hand-rolled HTTP like transcription (transcribe-cloud.ts), no
// provider SDK. logfare's documented speech table stops at `voice`, so
// its arm omits response_format (mp3 is the endpoint default either
// way). mp3 is the self-describing container — pcm needs rate/channels
// parsed out of Content-Type to be usable. The logfare and mimo arms
// pin the documented shape, unverified live until a key is
// provisioned. Resolved keys never enter logs.

import { z } from "zod";
import type { AuthStore } from "../auth.ts";
import type { TtsConfig } from "../config.ts";
import { log } from "../log.ts";
import { readBytesCapped, readTextCapped } from "./tools/web.ts";
import { renderError } from "./transcribe-cloud.ts";
import type { ChunkSynthesizer } from "./tts.ts";

const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";
const LOGFARE_SPEECH_URL = "https://logfare.ai/v1/audio/speech";
const MIMO_CHAT_URL = "https://api.xiaomimimo.com/v1/chat/completions";
// A 10k-char chunk of mp3 speech is single-digit MiB; the cap only
// guards a misbehaving gateway streaming garbage into memory.
const RESPONSE_CAP = 32 * 1024 * 1024;
const ERROR_BODY_CAP = 64 * 1024;
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_CHAR_MS = 40;
const TIMEOUT_MAX_MS = 300_000;

// Audio lands only at request end, so the timeout must cover the
// whole synthesis — scaled by input length, capped so a wedged
// request can't hold the voice lane. Exported: onemin-speech.ts's
// envelope budget rides the same scale (its POST + poll + download
// are one voice-lane synthesis).
export function timeoutMs(chars: number): number {
	return Math.min(TIMEOUT_BASE_MS + chars * TIMEOUT_PER_CHAR_MS, TIMEOUT_MAX_MS);
}

type CloudTtsCfg = Extract<TtsConfig, { kind: "openrouter" | "logfare" | "mimo" }>;

export function openrouterSpeech(
	cfg: CloudTtsCfg,
	auth: AuthStore,
	deps: { fetchFn?: typeof fetch | undefined } = {},
): ChunkSynthesizer {
	return openaiShapeSpeech("openrouter", OPENROUTER_SPEECH_URL, cfg, auth, deps);
}

export function logfareSpeech(
	cfg: CloudTtsCfg,
	auth: AuthStore,
	deps: { fetchFn?: typeof fetch | undefined } = {},
): ChunkSynthesizer {
	// Logfare's /audio/speech table lists only model/input/voice —
	// response_format stays off the wire rather than betting the relay
	// ignores unknown fields.
	return openaiShapeSpeech("logfare", LOGFARE_SPEECH_URL, cfg, auth, deps, {
		responseFormat: false,
	});
}

// Error envelopes share the renderError flavors already parsed for transcription.
function openaiShapeSpeech(
	kind: string,
	url: string,
	cfg: CloudTtsCfg,
	auth: AuthStore,
	deps: { fetchFn?: typeof fetch | undefined },
	// Fields beyond the OpenAI speech core are per-gateway docs.
	wire: { responseFormat: boolean } = { responseFormat: true },
): ChunkSynthesizer {
	const fetchFn = deps.fetchFn ?? fetch;
	return async (text, options) => {
		const key = await auth.resolve(cfg.auth);
		let res: Response;
		try {
			res = await fetchFn(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${key}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: cfg.model,
					input: text,
					// "" asks the model for its default voice — the field rides
					// only when a voice is actually named.
					...(options.voice !== "" ? { voice: options.voice } : {}),
					...(wire.responseFormat ? { response_format: options.outputFormat } : {}),
				}),
				signal: AbortSignal.timeout(timeoutMs(text.length)),
			});
		} catch (err) {
			throw new Error(`${kind}: request failed (${url}) — ${(err as Error).message}`);
		}
		if (!res.ok) {
			const { text: body } = await readTextCapped(res, ERROR_BODY_CAP);
			throw renderError(kind, res.status, body);
		}
		const { tooLarge, bytes } = await readBytesCapped(res, RESPONSE_CAP);
		if (tooLarge) throw new Error(`${kind}: response over ${RESPONSE_CAP} bytes`);
		if (bytes.byteLength === 0) throw new Error(`${kind}: empty audio response`);
		// X-Generation-Id is the billed-generation handle OpenRouter
		// support asks for — keep it in the log like transcription usage.
		const generation = res.headers.get("x-generation-id");
		log.debug(`${kind} speech chunk synthesized`, {
			model: cfg.model,
			chars: text.length,
			bytes: bytes.byteLength,
			...(generation !== null ? { generation } : {}),
		});
		return bytes;
	};
}

// ---------- mimo (chat-completions speech) ----------

// MiMo speaks through chat completions, not the /audio/speech shape:
// the target text rides an assistant message (an optional user message
// carries style direction — unused), and audio comes back base64 in
// choices[0].message.audio.data. Voice is a built-in id (mimo_default,
// Mia, …) — blank omits the field for the model default.
const mimoChatResponse = z.object({
	choices: z
		.array(
			z.object({
				finish_reason: z.string().optional(),
				message: z.object({
					audio: z.object({ data: z.string() }).optional(),
					final_text_preview: z.string().optional(),
				}),
			}),
		)
		.min(1),
});

export function mimoSpeech(
	cfg: CloudTtsCfg,
	auth: AuthStore,
	deps: { fetchFn?: typeof fetch | undefined } = {},
): ChunkSynthesizer {
	const fetchFn = deps.fetchFn ?? fetch;
	return async (text, options) => {
		const key = await auth.resolve(cfg.auth);
		let res: Response;
		try {
			res = await fetchFn(MIMO_CHAT_URL, {
				method: "POST",
				headers: {
					"api-key": key,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: cfg.model,
					messages: [{ role: "assistant", content: text }],
					audio: {
						format: options.outputFormat,
						...(options.voice !== "" ? { voice: options.voice } : {}),
					},
				}),
				signal: AbortSignal.timeout(timeoutMs(text.length)),
			});
		} catch (err) {
			throw new Error(`mimo: request failed (${MIMO_CHAT_URL}) — ${(err as Error).message}`);
		}
		const { tooLarge, text: body } = await readTextCapped(res, RESPONSE_CAP);
		if (tooLarge) throw new Error(`mimo: response over ${RESPONSE_CAP} bytes`);
		if (!res.ok) throw renderError("mimo", res.status, body);
		let parsed: z.output<typeof mimoChatResponse>;
		try {
			parsed = mimoChatResponse.parse(JSON.parse(body));
		} catch {
			throw new Error(
				`mimo: unexpected response shape — ${body.replace(/\s+/g, " ").trim().slice(0, 300)}`,
			);
		}
		const message = parsed.choices[0]?.message;
		const data = message?.audio?.data;
		if (message === undefined || data === undefined) {
			throw new Error("mimo: no audio in response");
		}
		const bytes = Buffer.from(data, "base64");
		if (bytes.byteLength === 0) throw new Error("mimo: empty audio response");
		log.debug("mimo speech chunk synthesized", {
			model: cfg.model,
			chars: text.length,
			bytes: bytes.byteLength,
			...(message.final_text_preview !== undefined
				? { finalTextPreview: message.final_text_preview }
				: {}),
		});
		return bytes;
	};
}
