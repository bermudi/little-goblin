// Wire pins for 1min.AI's /api door — TTS (TEXT_TO_SPEECH) and STT
// (SPEECH_TO_TEXT) through the aiRecord envelope. Doc-pinned, unverified
// live (no key provisioned yet): the fixtures below are the documented
// response shapes (docs.1min.ai → AI Feature API, Get Result API,
// Asset API, OpenAI Text-to-Speech, whisper-1/qwen3-asr-flash
// Speech-to-Text). The first live voice note is the probe — a red
// against these pins means the envelope moved, not the tests. One
// generalization: qwen3-asr-flash's page carries the only STT
// response example — "the transcript is resultObject[0]" is pinned
// from it and assumed for the family; whisper-1's page documents no
// response example (asr.md notes the assumption).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuthStore } from "../auth.ts";
import { oneminEngine, oneminSpeech } from "./onemin-speech.ts";

const auth: AuthStore = {
	resolve: async (name) => {
		if (name === "gone") throw new Error(`no such secret: ${name}`);
		return "test-1min-key";
	},
	has: () => true,
	names: () => ["onemin"],
};

function envelope(
	status: string,
	resultObject: string[],
	temporaryUrl = "",
	uuid = "rec-uuid",
): string {
	return JSON.stringify({
		aiRecord: {
			uuid,
			status,
			aiRecordDetail: { resultObject },
			temporaryUrl,
		},
	});
}

interface Call {
	url: string;
	headers: Record<string, string>;
	body?: unknown;
}

function dispatcher(
	handlers: Array<(call: Call, req: Request) => Response | Promise<Response> | undefined>,
) {
	const calls: Call[] = [];
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const req = input instanceof Request ? input : new Request(String(input), init);
		const headers = Object.fromEntries(req.headers.entries());
		let body: unknown;
		if (req.method !== "GET" && req.method !== "HEAD") {
			const raw = await req.text();
			try {
				body = JSON.parse(raw);
			} catch {
				body = raw;
			}
		}
		const call: Call = { url: req.url, headers, body };
		calls.push(call);
		for (const handler of handlers) {
			const res = await handler(call, req);
			if (res !== undefined) return res;
		}
		throw new Error(`unhandled fetch ${req.method} ${req.url}`);
	}) as typeof fetch;
	return { fetchFn, calls };
}

const jsonRes = (text: string) =>
	new Response(text, { status: 200, headers: { "content-type": "application/json" } });

describe("onemin TTS (TEXT_TO_SPEECH)", () => {
	test("SUCCESS envelope → audio downloaded from the signed URL, key never rides it", async () => {
		const d = dispatcher([
			(call) =>
				call.url === "https://api.1min.ai/api/features"
					? jsonRes(
							envelope(
								"SUCCESS",
								["development/audios/a1.mp3"],
								"https://s3.amazonaws.com/x/signed.mp3",
							),
						)
					: undefined,
			(call) =>
				call.url === "https://s3.amazonaws.com/x/signed.mp3"
					? new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
					: undefined,
		]);
		const synth = oneminSpeech(
			{ kind: "onemin", model: "tts-1", auth: "onemin", voice: "nova" },
			auth,
			{ fetchFn: d.fetchFn },
		);
		const bytes = await synth("Hello there", { voice: "nova", lang: "", outputFormat: "mp3" });
		expect([...bytes]).toEqual([1, 2, 3, 4]);
		expect(d.calls).toHaveLength(2);
		const [feature, download] = d.calls;
		expect(feature?.url).toBe("https://api.1min.ai/api/features");
		expect(feature?.headers["api-key"]).toBe("test-1min-key");
		// The documented request example carries the feature name as the
		// conversationId (docs → OpenAI Text-to-Speech → Request Example).
		expect(feature?.body).toEqual({
			type: "TEXT_TO_SPEECH",
			model: "tts-1",
			conversationId: "TEXT_TO_SPEECH",
			promptObject: {
				text: "Hello there",
				voice: "nova",
				response_format: "mp3",
			},
		});
		// The signed URL carries its own authorization — the 1min key
		// must never ride a fetch to a foreign host.
		expect(download?.url).toBe("https://s3.amazonaws.com/x/signed.mp3");
		expect(download?.headers["api-key"]).toBeUndefined();
		expect(download?.headers.authorization).toBeUndefined();
	});

	test("blank voice falls back to alloy, the tts-1 default", async () => {
		const d = dispatcher([
			(call) =>
				call.url.endsWith("/api/features")
					? jsonRes(envelope("SUCCESS", [], "https://s3/x.mp3"))
					: undefined,
			(call) => (call.url === "https://s3/x.mp3" ? new Response(new Uint8Array([9])) : undefined),
		]);
		const synth = oneminSpeech(
			{ kind: "onemin", model: "tts-1", auth: "onemin", voice: "" },
			auth,
			{
				fetchFn: d.fetchFn,
			},
		);
		await synth("hi", { voice: "", lang: "", outputFormat: "mp3" });
		const [feature] = d.calls;
		expect((feature?.body as { promptObject: { voice: string } }).promptObject.voice).toBe("alloy");
	});

	test("PROCESSING polls GET /api/results/:uuid until SUCCESS", async () => {
		let polls = 0;
		const d = dispatcher([
			(call) =>
				call.url.endsWith("/api/features")
					? jsonRes(envelope("PROCESSING", [], "", "uuid-42"))
					: undefined,
			(call) => {
				if (call.url === "https://api.1min.ai/api/results/uuid-42") {
					polls += 1;
					return polls < 2
						? jsonRes(envelope("PROCESSING", [], "", "uuid-42"))
						: jsonRes(envelope("SUCCESS", [], "https://s3/late.mp3", "uuid-42"));
				}
				return undefined;
			},
			(call) =>
				call.url === "https://s3/late.mp3" ? new Response(new Uint8Array([7, 7])) : undefined,
		]);
		const synth = oneminSpeech(
			{ kind: "onemin", model: "tts-1-hd", auth: "onemin", voice: "echo" },
			auth,
			{ fetchFn: d.fetchFn, pollIntervalMs: 5 },
		);
		const bytes = await synth("text", { voice: "echo", lang: "", outputFormat: "mp3" });
		expect([...bytes]).toEqual([7, 7]);
		// GET, not a re-POST of the billed feature call — polling is free.
		const poll = d.calls[1];
		expect(poll?.body).toBeUndefined();
		expect(poll?.headers["api-key"]).toBe("test-1min-key");
		expect(polls).toBe(2);
	});

	test("a non-ok features answer renders the provider's own message", async () => {
		const d = dispatcher([
			(call) =>
				call.url.endsWith("/api/features")
					? new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 })
					: undefined,
		]);
		const synth = oneminSpeech(
			{ kind: "onemin", model: "tts-1", auth: "onemin", voice: "alloy" },
			auth,
			{
				fetchFn: d.fetchFn,
			},
		);
		expect(synth("x", { voice: "alloy", lang: "", outputFormat: "mp3" })).rejects.toThrow(
			/onemin: HTTP 401 .*Invalid API key/,
		);
	});

	test("a settled non-SUCCESS status without a failure object fails loud, naming it", async () => {
		const d = dispatcher([
			(call) =>
				call.url.endsWith("/api/features")
					? jsonRes(envelope("FAILED", [], "", "uuid-9"))
					: undefined,
		]);
		const synth = oneminSpeech(
			{ kind: "onemin", model: "tts-1", auth: "onemin", voice: "alloy" },
			auth,
			{
				fetchFn: d.fetchFn,
			},
		);
		expect(synth("x", { voice: "alloy", lang: "", outputFormat: "mp3" })).rejects.toThrow(
			/TEXT_TO_SPEECH ended with status "FAILED"/,
		);
	});

	test("a SUCCESS envelope without temporaryUrl cannot be faked into audio", async () => {
		const d = dispatcher([
			(call) => (call.url.endsWith("/api/features") ? jsonRes(envelope("SUCCESS", [])) : undefined),
		]);
		const synth = oneminSpeech(
			{ kind: "onemin", model: "tts-1", auth: "onemin", voice: "alloy" },
			auth,
			{
				fetchFn: d.fetchFn,
			},
		);
		expect(synth("x", { voice: "alloy", lang: "", outputFormat: "mp3" })).rejects.toThrow(
			/temporaryUrl missing/,
		);
	});

	test("an auth failure propagates before any wire", async () => {
		const d = dispatcher([]);
		const synth = oneminSpeech(
			{ kind: "onemin", model: "tts-1", auth: "gone", voice: "alloy" },
			auth,
			{
				fetchFn: d.fetchFn,
			},
		);
		expect(synth("x", { voice: "alloy", lang: "", outputFormat: "mp3" })).rejects.toThrow(
			/no such secret: gone/,
		);
		expect(d.calls).toHaveLength(0);
	});

	test("a FAILURE envelope surfaces the provider's error object, not a shape violation", async () => {
		// Verbatim shape from docs → Get Result API → When Failure:
		// HTTP 200, status "FAILURE", resultObject an error OBJECT
		// (code/name/message/traceId) — the zod schema must accept it
		// and the error must carry the provider's message.
		const failure = JSON.stringify({
			aiRecord: {
				uuid: "120qae97-d77d-468d-9d78-2e7c0b2bbb98",
				userId: "75cz1a57-c969-47ac-9dc5-82941cdcfe57",
				teamId: "595w4b41-dcc7-466f-8697-4d919810b11",
				model: "tts-1",
				type: "TEXT_TO_SPEECH",
				status: "FAILURE",
				aiRecordDetail: {
					promptObject: { text: "hello", voice: "alloy", response_format: "mp3" },
					resultObject: {
						code: "PIAPI_TASK_RESPONSE_ERROR",
						name: "ExternalError",
						context: '{"service":"piapi"}',
						details: "{}",
						message:
							"The piapi service is a bit busy right now or facing a temporary issue. Please try again shortly. We appreciate your patience!",
						traceId: "a9c68601366f6e79216d23cdf0571cdd",
						errorSeverity: "high",
					},
				},
				temporaryUrl: "",
			},
		});
		const d = dispatcher([
			(call) => (call.url.endsWith("/api/features") ? jsonRes(failure) : undefined),
		]);
		const synth = oneminSpeech(
			{ kind: "onemin", model: "tts-1", auth: "onemin", voice: "alloy" },
			auth,
			{
				fetchFn: d.fetchFn,
			},
		);
		expect(synth("hello", { voice: "alloy", lang: "", outputFormat: "mp3" })).rejects.toThrow(
			/failed \(status "FAILURE"\) \(PIAPI_TASK_RESPONSE_ERROR\): The piapi service is a bit busy right now/,
		);
	});
});

describe("onemin STT (SPEECH_TO_TEXT)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "onemin-stt-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function oggFile(): Promise<string> {
		const path = join(dir, "voice.ogg");
		// A keep-profile segment is mono 48k opus in an ogg container —
		// 1min accepts ogg/opus; the magic bytes are all the engine reads.
		await writeFile(path, new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]));
		return path;
	}

	const speechFile = async () => ({
		path: await oggFile(),
		filename: "voice.ogg",
		mediaType: "audio/ogg",
	});

	test("whisper-1: asset upload → feature call, transcript is the resultObject entry", async () => {
		const d = dispatcher([
			(call) =>
				call.url === "https://api.1min.ai/api/assets"
					? jsonRes(JSON.stringify({ fileContent: { path: "audios/xyz.ogg" } }))
					: undefined,
			(call) =>
				call.url.endsWith("/api/features")
					? jsonRes(envelope("SUCCESS", ["Hello, this is the transcript."], "", "u1"))
					: undefined,
		]);
		const engine = oneminEngine(
			{ kind: "onemin", model: "whisper-1", auth: "onemin", language: undefined },
			auth,
			{ fetchFn: d.fetchFn },
		);
		expect(engine.id).toBe("onemin/whisper-1");
		// whisper-1's format table lists OGG and MP4 — native
		// containers stay (keep profile), segments under the 10 MB cap.
		expect(engine.limits).toEqual({ maxBytes: 10 * 1024 * 1024, maxSeconds: 15 * 60 });
		expect(engine.prep).toEqual({ container: "keep" });
		const file = await speechFile();
		const out = await engine.transcribe(file);
		expect(out).toEqual({ text: "Hello, this is the transcript." });
		expect(d.calls).toHaveLength(2);
		const [upload, feature] = d.calls;
		// Multipart field "asset" (docs → Asset API), API-KEY header —
		// not Bearer, unlike the OpenAI-compatible chat door.
		expect(String(upload?.body)).toContain("asset");
		expect(upload?.headers["api-key"]).toBe("test-1min-key");
		expect(feature?.body).toEqual({
			type: "SPEECH_TO_TEXT",
			model: "whisper-1",
			// whisper-1 answers a response_format; the STT examples carry
			// no conversationId. STT rides the async door — PROCESSING at
			// once, then poll (docs → AI Feature API → Async Requests).
			async: true,
			promptObject: { audioUrl: "audios/xyz.ogg", response_format: "text" },
		});
	});

	test("qwen3-asr-flash: no response_format, language passthrough, alternative asset key", async () => {
		const d = dispatcher([
			(call) =>
				call.url.endsWith("/api/assets")
					? jsonRes(JSON.stringify({ asset: { key: "development/assets/q.ogg" } }))
					: undefined,
			(call) =>
				call.url.endsWith("/api/features") ? jsonRes(envelope("SUCCESS", ["你好"])) : undefined,
		]);
		const engine = oneminEngine(
			{ kind: "onemin", model: "qwen3-asr-flash", auth: "onemin", language: "zh" },
			auth,
			{ fetchFn: d.fetchFn },
		);
		// qwen3's format table is the one without MP4 — Telegram video
		// notes arrive as .mp4, so it rides the wav profile (16 kHz mono
		// pcm_s16le is on every documented list) instead of keep.
		expect(engine.prep).toEqual({ container: "wav", sampleRateHz: 16_000, mono: true });
		expect(engine.limits).toEqual({ maxSeconds: 280 });
		const out = await engine.transcribe(await speechFile());
		expect(out).toEqual({ text: "你好" });
		const [, feature] = d.calls;
		expect(feature?.body).toEqual({
			type: "SPEECH_TO_TEXT",
			model: "qwen3-asr-flash",
			async: true,
			promptObject: { audioUrl: "development/assets/q.ogg", language: "zh" },
		});
	});

	test("latest_short carries the BCP-47 language the model requires", async () => {
		const d = dispatcher([
			(call) =>
				call.url.endsWith("/api/assets")
					? jsonRes(JSON.stringify({ fileContent: { path: "a" } }))
					: undefined,
			(call) =>
				call.url.endsWith("/api/features") ? jsonRes(envelope("SUCCESS", ["hi"])) : undefined,
		]);
		const engine = oneminEngine(
			{ kind: "onemin", model: "latest_short", auth: "onemin", language: "en-US" },
			auth,
			{ fetchFn: d.fetchFn },
		);
		const out = await engine.transcribe(await speechFile());
		expect(out).toEqual({ text: "hi" });
		const [, feature] = d.calls;
		expect(feature?.body).toEqual({
			type: "SPEECH_TO_TEXT",
			model: "latest_short",
			async: true,
			promptObject: { audioUrl: "a", language: "en-US" },
		});
	});

	test("an empty resultObject is the orchestrator's null, not an error", async () => {
		const d = dispatcher([
			(call) =>
				call.url.endsWith("/api/assets")
					? jsonRes(JSON.stringify({ fileContent: { path: "a" } }))
					: undefined,
			(call) => (call.url.endsWith("/api/features") ? jsonRes(envelope("SUCCESS", [])) : undefined),
		]);
		const engine = oneminEngine(
			{ kind: "onemin", model: "whisper-1", auth: "onemin", language: undefined },
			auth,
			{ fetchFn: d.fetchFn },
		);
		const out = await engine.transcribe(await speechFile());
		expect(out).toEqual({ text: "" });
	});

	test("a SUCCESS record with no resultObject names the drift, never silence", async () => {
		// The documented SUCCESS shape populates resultObject — a record
		// without it is contract drift, and "" would read as "no speech".
		const d = dispatcher([
			(call) =>
				call.url.endsWith("/api/assets")
					? jsonRes(JSON.stringify({ fileContent: { path: "a" } }))
					: undefined,
			(call) =>
				call.url.endsWith("/api/features")
					? jsonRes(
							JSON.stringify({
								aiRecord: { uuid: "u-drift", status: "SUCCESS", temporaryUrl: "" },
							}),
						)
					: undefined,
		]);
		const engine = oneminEngine(
			{ kind: "onemin", model: "whisper-1", auth: "onemin", language: undefined },
			auth,
			{ fetchFn: d.fetchFn },
		);
		expect(engine.transcribe(await speechFile())).rejects.toThrow(
			/SUCCESS without a resultObject array \(uuid u-drift\)/,
		);
	});

	test("a SUCCESS record whose resultObject is the error-object shape fails loud too", async () => {
		// The schema accepts the FAILURE error-object shape so failure
		// records parse; that shape drifting onto SUCCESS is drift all
		// the same — name it, never map it to "no speech".
		const d = dispatcher([
			(call) =>
				call.url.endsWith("/api/assets")
					? jsonRes(JSON.stringify({ fileContent: { path: "a" } }))
					: undefined,
			(call) =>
				call.url.endsWith("/api/features")
					? jsonRes(
							JSON.stringify({
								aiRecord: {
									uuid: "u-obj",
									status: "SUCCESS",
									aiRecordDetail: {
										resultObject: {
											code: "PIAPI_TASK_RESPONSE_ERROR",
											message: "busy",
										},
									},
								},
							}),
						)
					: undefined,
		]);
		const engine = oneminEngine(
			{ kind: "onemin", model: "whisper-1", auth: "onemin", language: undefined },
			auth,
			{ fetchFn: d.fetchFn },
		);
		expect(engine.transcribe(await speechFile())).rejects.toThrow(
			/SUCCESS without a resultObject array \(uuid u-obj\)/,
		);
	});

	test("a poll answering aiRecord null names the Not-Found case", async () => {
		// Verbatim from docs → Get Result API → Not Found (200):
		// an unknown/inaccessible uuid answers {"aiRecord": null} —
		// distinct from PROCESSING, and not a shape violation.
		const d = dispatcher([
			(call) =>
				call.url.endsWith("/api/assets")
					? jsonRes(JSON.stringify({ fileContent: { path: "a" } }))
					: undefined,
			(call) =>
				call.url.endsWith("/api/features")
					? jsonRes(envelope("PROCESSING", [], "", "uuid-7"))
					: undefined,
			(call) =>
				call.url.endsWith("/api/results/uuid-7") ? jsonRes('{"aiRecord": null}') : undefined,
		]);
		const engine = oneminEngine(
			{ kind: "onemin", model: "whisper-1", auth: "onemin", language: undefined },
			auth,
			{ fetchFn: d.fetchFn, pollIntervalMs: 5 },
		);
		expect(engine.transcribe(await speechFile())).rejects.toThrow(
			/no such result record \(uuid uuid-7\) — deleted, expired, or another key's record/,
		);
	});
	test("an asset answer without any storage path fails loud", async () => {
		const d = dispatcher([
			(call) =>
				call.url.endsWith("/api/assets") ? jsonRes(JSON.stringify({ ok: true })) : undefined,
		]);
		const engine = oneminEngine(
			{ kind: "onemin", model: "whisper-1", auth: "onemin", language: undefined },
			auth,
			{ fetchFn: d.fetchFn },
		);
		expect(engine.transcribe(await speechFile())).rejects.toThrow(/no storage path/);
	});
});
