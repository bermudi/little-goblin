// Cloud speech engines — hand-rolled HTTP like TTS (tts.ts), no
// provider SDK. One multipart implementation serves every
// OpenAI-compatible /audio/transcriptions endpoint; groq is the first
// kind (openai/mistral join as base-URL constants, design/asr.md).
//
// Response and error shapes are pinned verbatim in transcribe-cloud
// .test.ts (probed live 2026-10-09 — design/asr.md → Verbatim
// contracts). Resolved keys never enter logs.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AuthStore } from "../auth.ts";
import type { TranscriptionConfig } from "../config.ts";
import { readTextCapped } from "./tools/web.ts";
import type { EngineDeps, EngineTranscript, SpeechEngine } from "./transcribe.ts";

// Groq's multipart cap is 25 MiB — over that, segment instead of
// guessing at a request that 413s anyway.
const MULTIPART_MAX_BYTES = 25 * 1024 * 1024;
// 15 minutes of 48k mono opus ≈ 5.5 MiB — comfortably under the cap no
// matter the source bitrate.
const MULTIPART_SEGMENT_SECONDS = 15 * 60;
const MULTIPART_TIMEOUT_MS = 60_000;
// A transcript scales with input length; a misbehaving gateway must not
// stream gigabytes into memory.
const RESPONSE_CAP = 8 * 1024 * 1024;
const ERROR_HEAD = 300;

// {"text": …} — the minimal shape every OpenAI-compatible endpoint
// returns without response_format=verbose_json. Language/duration only
// exist in verbose responses (groq's is full words, not codes) —
// present means logged, never interpreted.
const multipartResponse = z.object({
	text: z.string(),
	language: z.string().optional(),
});

export function groqEngine(
	cfg: Extract<TranscriptionConfig, { kind: "groq" }>,
	auth: AuthStore,
	deps: EngineDeps = {},
): SpeechEngine {
	return openAiCompatible(
		"groq",
		cfg,
		auth,
		"https://api.groq.com/openai/v1/audio/transcriptions",
		deps,
	);
}

// groq/openai/mistral share one wire: multipart file+model(+language),
// Bearer auth, {"text": …} back. Differences are the URL and the error
// body flavor, both handled in renderError.
function openAiCompatible(
	kind: string,
	cfg: { model: string; auth: string; language?: string | undefined },
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

// Shared POST for every cloud kind: timeout, network-error naming, and
// status passthrough (callers render the error body). `logUrl` is what
// boundary lines carry — it never contains credentials (keys ride
// headers, never query strings).
async function httpPost(
	kind: string,
	url: string,
	init: { headers: Record<string, string>; body: FormData | string; deps: EngineDeps; timeoutMs: number },
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
