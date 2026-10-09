import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStore } from "../auth.ts";
import {
	elevenlabsEngine,
	geminiEngine,
	groqEngine,
	mimoEngine,
	mistralEngine,
	openaiEngine,
	openrouterEngine,
} from "./transcribe-cloud.ts";

const auth: AuthStore = {
	resolve: async (name) => {
		if (name === "gone") throw new Error("no such secret: gone");
		return "test-key-material";
	},
	has: () => true,
	names: () => ["groq"],
};

let dirs: string[] = [];
function tmpdir_(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-cloud-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

interface SeenRequest {
	url: string;
	headers: Record<string, string>;
	body: FormData;
}

// A fetch fake that records the request and answers with a canned
// response — the pinned bodies below are the verbatim shapes recorded
// in design/asr.md → Verbatim contracts (probed live 2026-10-09).
const fakeFetch = (status: number, body: string) => {
	const seen: SeenRequest[] = [];
	const fn = (async (url: string | URL | Request, init?: RequestInit) => {
		seen.push({
			url: String(url),
			headers: Object.fromEntries(
			Object.entries((init?.headers as Record<string, string>) ?? {}),
			),
			body: init?.body as FormData,
		});
		return new Response(body, { status });
	}) as typeof fetch;
	const last = (): SeenRequest => {
		const req = seen.at(-1);
		if (req === undefined) throw new Error("fake fetch saw no request");
		return req;
	};
	return { fn, seen, last };
};

function voiceFile(): { path: string; mediaType: string; filename: string } {
	const f = join(tmpdir_(), "v.ogg");
	writeFileSync(f, "ogg-bytes");
	return { path: f, mediaType: "audio/ogg", filename: "v.ogg" };
}

describe("groqEngine", () => {
	test("posts multipart with the resolved key and returns the text", async () => {
		const { fn, last } = fakeFetch(
			200,
			// Groq without response_format=verbose_json answers the
			// minimal OpenAI-compatible shape.
			JSON.stringify({ text: " Hey Goblin, please turn off the kitchen lights." }),
		);
		const engine = groqEngine({ kind: "groq", model: "whisper-large-v3-turbo", auth: "groq" }, auth, {
			fetchFn: fn,
		});
		const result = await engine.transcribe(voiceFile());
		expect(result.text).toBe(" Hey Goblin, please turn off the kitchen lights.");
		const req = last();
		expect(req.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
		expect(req.headers.authorization).toBe("Bearer test-key-material");
		expect(req.body.get("model")).toBe("whisper-large-v3-turbo");
		const uploaded = req.body.get("file");
		expect(uploaded).toBeInstanceOf(File);
		expect((uploaded as File).name).toBe("v.ogg");
		expect(req.body.get("language")).toBeNull();
	});

	test("language config rides the form when set", async () => {
		const { fn, last } = fakeFetch(200, JSON.stringify({ text: "hola" }));
		const engine = groqEngine(
			{ kind: "groq", model: "whisper-large-v3-turbo", auth: "groq", language: "es" },
			auth,
			{ fetchFn: fn },
		);
		await engine.transcribe(voiceFile());
		expect(last().body.get("language")).toBe("es");
	});

	test("the pinned 401 body renders as a loud, named error", async () => {
		const { fn } = fakeFetch(
			401,
			JSON.stringify({
				error: {
					message: "Invalid API Key",
					type: "invalid_request_error",
					code: "invalid_api_key",
				},
			}),
		);
		const engine = groqEngine({ kind: "groq", model: "whisper-large-v3-turbo", auth: "groq" }, auth, {
			fetchFn: fn,
		});
		await expect(engine.transcribe(voiceFile())).rejects.toThrow(
			"groq: HTTP 401 — Invalid API Key",
		);
	});

	test("a network failure names the provider, never the key", async () => {
		const fn = (async () => {
			throw new Error("ECONNRESET");
		}) as unknown as typeof fetch;
		const engine = groqEngine({ kind: "groq", model: "whisper-large-v3-turbo", auth: "groq" }, auth, {
			fetchFn: fn,
		});
		await expect(engine.transcribe(voiceFile())).rejects.toThrow(
			"groq: request failed (https://api.groq.com/openai/v1/audio/transcriptions) — ECONNRESET",
		);
	});

	test("a non-JSON success body fails loud", async () => {
		const { fn } = fakeFetch(200, "<html>gateway oops</html>");
		const engine = groqEngine({ kind: "groq", model: "whisper-large-v3-turbo", auth: "groq" }, auth, {
			fetchFn: fn,
		});
		await expect(engine.transcribe(voiceFile())).rejects.toThrow("response is not JSON");
	});

	test("a JSON body without text fails loud with the head", async () => {
		const { fn } = fakeFetch(200, JSON.stringify({ task: "transcribe", segments: [] }));
		const engine = groqEngine({ kind: "groq", model: "whisper-large-v3-turbo", auth: "groq" }, auth, {
			fetchFn: fn,
		});
		await expect(engine.transcribe(voiceFile())).rejects.toThrow("unexpected response shape");
	});

	test("a missing auth record propagates before any request", async () => {
		const { fn, seen } = fakeFetch(200, JSON.stringify({ text: "x" }));
		const engine = groqEngine({ kind: "groq", model: "whisper-large-v3-turbo", auth: "gone" }, auth, {
			fetchFn: fn,
		});
		await expect(engine.transcribe(voiceFile())).rejects.toThrow("no such secret: gone");
		expect(seen.length).toBe(0);
	});
});

// Pinned live bodies for the other kinds (design/asr.md → Verbatim
// contracts; openrouter-ogg and mimo probed live during implementation).
describe("openaiEngine", () => {
	test("success returns the text; 401 renders the pinned shape", async () => {
		const ok = fakeFetch(200, JSON.stringify({ text: "call me back" }));
		const engine = openaiEngine({ model: "gpt-4o-mini-transcribe", auth: "openai" }, auth, {
			fetchFn: ok.fn,
		});
		expect((await engine.transcribe(voiceFile())).text).toBe("call me back");
		expect(ok.last().url).toBe("https://api.openai.com/v1/audio/transcriptions");
		expect(ok.last().body.get("model")).toBe("gpt-4o-mini-transcribe");

		const bad = fakeFetch(
			401,
			JSON.stringify({
				error: {
					message: "Incorrect API key provided: sk-…",
					type: "invalid_request_error",
					param: null,
					code: "invalid_api_key",
				},
			}),
		);
		const failing = openaiEngine({ model: "gpt-4o-mini-transcribe", auth: "openai" }, auth, {
			fetchFn: bad.fn,
		});
		await expect(failing.transcribe(voiceFile())).rejects.toThrow(
			"openai: HTTP 401 — Incorrect API key provided: sk-…",
		);
	});
});

describe("mistralEngine", () => {
	test("success returns the text; the FastAPI detail error renders", async () => {
		const ok = fakeFetch(200, JSON.stringify({ text: "rappelle-moi" }));
		const engine = mistralEngine({ model: "mistralai/voxtral-mini-3b-2507", auth: "mistral" }, auth, {
			fetchFn: ok.fn,
		});
		expect((await engine.transcribe(voiceFile())).text).toBe("rappelle-moi");
		expect(ok.last().url).toBe("https://api.mistral.ai/v1/audio/transcriptions");

		const bad = fakeFetch(401, JSON.stringify({ detail: "Invalid API Key" }));
		const failing = mistralEngine({ model: "mistralai/voxtral-mini-3b-2507", auth: "mistral" }, auth, {
			fetchFn: bad.fn,
		});
		await expect(failing.transcribe(voiceFile())).rejects.toThrow(
			"mistral: HTTP 401 — Invalid API Key",
		);
	});
});

describe("openrouterEngine", () => {
	test("posts base64 audio with the format mapped from the extension", async () => {
		// Verbatim 200 from the 2026-10-09 probe (wav input).
		const { fn, last } = fakeFetch(
			200,
			JSON.stringify({
				text: " Hey Goblin, please turn off the kitchen lights and set a timer for 10 minutes.",
				usage: { seconds: 5.603, cost: 0.0000420225 },
			}),
		);
		const engine = openrouterEngine({ model: "openai/whisper-large-v3", auth: "openrouter" }, auth, {
			fetchFn: fn,
		});
		const result = await engine.transcribe(voiceFile());
		expect(result.text).toBe(
			" Hey Goblin, please turn off the kitchen lights and set a timer for 10 minutes.",
		);
		const req = last();
		expect(req.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
		const body = JSON.parse(String(req.body)) as {
			model: string;
			input_audio: { data: string; format: string };
		};
		expect(body.model).toBe("openai/whisper-large-v3");
		expect(body.input_audio.format).toBe("ogg");
		expect(body.input_audio.data).toBe(Buffer.from("ogg-bytes").toString("base64"));
	});

	test(".oga maps to ogg, .wav to wav; an unmapped extension fails loud", async () => {
		const { fn, last } = fakeFetch(200, JSON.stringify({ text: "x" }));
		const engine = openrouterEngine({ model: "openai/whisper-large-v3", auth: "openrouter" }, auth, {
			fetchFn: fn,
		});
		for (const [name, format] of [
			["n.oga", "ogg"],
			["n.wav", "wav"],
		] as const) {
			const f = join(tmpdir_(), name);
			writeFileSync(f, "x");
			await engine.transcribe({ path: f, mediaType: "audio/ogg", filename: name });
			const body = JSON.parse(String(last().body)) as { input_audio: { format: string } };
			expect(body.input_audio.format).toBe(format);
		}
		const f = join(tmpdir_(), "n.flac");
		writeFileSync(f, "x");
		await expect(
			engine.transcribe({ path: f, mediaType: "audio/flac", filename: "n.flac" }),
		).rejects.toThrow('no input_audio format for ".flac"');
	});
});

describe("elevenlabsEngine", () => {
	test("uses the xi-api-key header, model_id field, and returns language_code", async () => {
		// Verbatim 200 shape from the API reference (scribe_v2).
		const { fn, last } = fakeFetch(
			200,
			JSON.stringify({
				language_code: "en",
				language_probability: 1,
				text: "call me back please",
				words: [{ text: "call", start: 0.1, end: 0.4, type: "word" }],
			}),
		);
		const engine = elevenlabsEngine({ model: "scribe_v2", auth: "elevenlabs" }, auth, {
			fetchFn: fn,
		});
		const result = await engine.transcribe(voiceFile());
		expect(result).toEqual({ text: "call me back please", language: "en" });
		const req = last();
		expect(req.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
		expect(req.headers.authorization).toBeUndefined();
		expect(req.headers["xi-api-key"]).toBe("test-key-material");
		expect(req.body.get("model_id")).toBe("scribe_v2");
	});
});

describe("geminiEngine", () => {
	const file = (): { path: string; mediaType: string; filename: string } => voiceFile();

	function candidates(parts: Array<{ text?: string }>, finishReason?: string): string {
		return JSON.stringify({
			candidates: [
				{
					content: { parts },
					...(finishReason !== undefined ? { finishReason } : {}),
				},
			],
		});
	}

	test("joins parts into the transcript with the prompt as a text part", async () => {
		const { fn, last } = fakeFetch(200, candidates([{ text: "hello " }, { text: "goblin" }]));
		const engine = geminiEngine({ model: "gemini-flash-latest", auth: "gemini" }, auth, {
			fetchFn: fn,
		});
		expect((await engine.transcribe(file())).text).toBe("hello goblin");
		const req = last();
		expect(req.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
		);
		expect(req.headers["x-goog-api-key"]).toBe("test-key-material");
		const body = JSON.parse(String(req.body)) as {
			contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
			generationConfig: { temperature: number; maxOutputTokens: number };
		};
		expect(body.contents[0]?.role).toBe("user");
		expect(body.contents[0]?.parts[0]?.inlineData).toEqual({
			mimeType: "audio/ogg",
			data: Buffer.from("ogg-bytes").toString("base64"),
		});
		expect((body.contents[0]?.parts[1]?.text as string).startsWith("Transcribe the audio verbatim.")).toBe(
			true,
		);
		expect(body.generationConfig.temperature).toBe(0);
	});

	test("a safety block with no text fails loud, never reads as silence", async () => {
		const { fn } = fakeFetch(200, candidates([], "PROHIBITED_CONTENT"));
		const engine = geminiEngine({ model: "gemini-flash-latest", auth: "gemini" }, auth, {
			fetchFn: fn,
		});
		await expect(engine.transcribe(file())).rejects.toThrow(
			"gemini: no transcript — finishReason PROHIBITED_CONTENT",
		);
	});

	test("an api error renders its message", async () => {
		const { fn } = fakeFetch(
			400,
			JSON.stringify({ error: { code: 400, message: "Invalid JSON payload.", status: "INVALID_ARGUMENT" } }),
		);
		const engine = geminiEngine({ model: "gemini-flash-latest", auth: "gemini" }, auth, {
			fetchFn: fn,
		});
		await expect(engine.transcribe(file())).rejects.toThrow(
			"gemini: HTTP 400 — Invalid JSON payload.",
		);
	});
});

describe("mimoEngine", () => {
	test("chats the audio with the transcription prompt and returns the content", async () => {
		// Verbatim 200 from the 2026-10-10 live probe (trimmed to the
		// fields the parser reads).
		const { fn, last } = fakeFetch(
			200,
			JSON.stringify({
				id: "gen-1791572519-U3sXL3ZIm5uQZcFJrw0w",
				object: "chat.completion",
				model: "xiaomi/mimo-v2.6-flash",
				choices: [
					{
						index: 0,
						finish_reason: "stop",
						message: { role: "assistant", content: "call me back" },
					},
				],
				usage: { prompt_tokens: 54, completion_tokens: 2, total_tokens: 56, cost: 0.00000758 },
			}),
		);
		const engine = mimoEngine({ model: "xiaomi/mimo-v2.6-flash", auth: "openrouter" }, auth, {
			fetchFn: fn,
		});
		expect((await engine.transcribe(voiceFile())).text).toBe("call me back");
		const req = last();
		expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		const body = JSON.parse(String(req.body)) as {
			model: string;
			temperature: number;
			messages: Array<{
				role: string;
				content: Array<{ type: string; input_audio?: { data: string; format: string }; text?: string }>;
			}>;
		};
		expect(body.model).toBe("xiaomi/mimo-v2.6-flash");
		expect(body.temperature).toBe(0);
		const [audioPart, textPart] = body.messages[0]?.content ?? [];
		expect(audioPart?.type).toBe("input_audio");
		expect(audioPart?.input_audio?.format).toBe("ogg");
		expect(audioPart?.input_audio?.data).toBe(Buffer.from("ogg-bytes").toString("base64"));
		expect(textPart?.type).toBe("text");
	});

	test("empty model output is silence, not failure", async () => {
		const { fn } = fakeFetch(
			200,
			JSON.stringify({
				choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "" } }],
			}),
		);
		const engine = mimoEngine({ model: "xiaomi/mimo-v2.6-flash", auth: "openrouter" }, auth, {
			fetchFn: fn,
		});
		expect(await engine.transcribe(voiceFile())).toEqual({ text: "" });
	});
});
