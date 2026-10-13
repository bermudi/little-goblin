// Cloud speech synthesis — hand-rolled HTTP like transcription
// (transcribe-cloud.ts), no provider SDK. OpenRouter's TTS endpoint is
// one POST shape for every upstream speech model: {model, input,
// voice?, response_format} in, raw audio bytes out — never JSON on
// success; errors are the usual {"error": {code, message}} envelope.
// The wire contract is pinned verbatim in tts-cloud.test.ts against
// the OpenRouter TTS docs (mp3 is the self-describing container —
// pcm needs rate/channels parsed out of Content-Type to be usable).
// Resolved keys never enter logs.

import type { AuthStore } from "../auth.ts";
import type { TtsConfig } from "../config.ts";
import { log } from "../log.ts";
import { readBytesCapped, readTextCapped } from "./tools/web.ts";
import { renderError } from "./transcribe-cloud.ts";
import type { ChunkSynthesizer } from "./tts.ts";

const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";
// A 10k-char chunk of mp3 speech is single-digit MiB; the cap only
// guards a misbehaving gateway streaming garbage into memory.
const RESPONSE_CAP = 32 * 1024 * 1024;
const ERROR_BODY_CAP = 64 * 1024;
// Same budget shape as edge (tts.ts): audio lands only at request end,
// so the timeout must cover the whole synthesis — scaled by input
// length, capped so a wedged request can't hold the voice lane.
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_CHAR_MS = 40;
const TIMEOUT_MAX_MS = 300_000;

function timeoutMs(chars: number): number {
	return Math.min(TIMEOUT_BASE_MS + chars * TIMEOUT_PER_CHAR_MS, TIMEOUT_MAX_MS);
}

export function openrouterSpeech(
	cfg: Extract<TtsConfig, { kind: "openrouter" }>,
	auth: AuthStore,
	deps: { fetchFn?: typeof fetch | undefined } = {},
): ChunkSynthesizer {
	const fetchFn = deps.fetchFn ?? fetch;
	return async (text, options) => {
		const key = await auth.resolve(cfg.auth);
		let res: Response;
		try {
			res = await fetchFn(OPENROUTER_SPEECH_URL, {
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
					response_format: options.outputFormat,
				}),
				signal: AbortSignal.timeout(timeoutMs(text.length)),
			});
		} catch (err) {
			throw new Error(
				`openrouter: request failed (${OPENROUTER_SPEECH_URL}) — ${(err as Error).message}`,
			);
		}
		if (!res.ok) {
			const { text: body } = await readTextCapped(res, ERROR_BODY_CAP);
			throw renderError("openrouter", res.status, body);
		}
		const { tooLarge, bytes } = await readBytesCapped(res, RESPONSE_CAP);
		if (tooLarge) throw new Error(`openrouter: response over ${RESPONSE_CAP} bytes`);
		if (bytes.byteLength === 0) throw new Error("openrouter: empty audio response");
		// X-Generation-Id is the billed-generation handle OpenRouter
		// support asks for — keep it in the log like transcription usage.
		const generation = res.headers.get("x-generation-id");
		log.debug("openrouter speech chunk synthesized", {
			model: cfg.model,
			chars: text.length,
			bytes: bytes.byteLength,
			...(generation !== null ? { generation } : {}),
		});
		return bytes;
	};
}
