import { describe, expect, test } from "bun:test";
import type { AuthStore } from "../auth.ts";
import { synthesizeSpeech } from "./tts.ts";
import { openrouterSpeech } from "./tts-cloud.ts";

const auth: AuthStore = {
	resolve: async (name) => {
		if (name === "gone") throw new Error("no such secret: gone");
		return "test-key-material";
	},
	has: () => true,
	names: () => ["openrouter"],
};

interface SeenRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

// A fetch fake that records the request and answers canned bytes — the
// pinned shapes below are OpenRouter's documented TTS contract: JSON
// in, raw audio bytes out, {"error": {code, message}} on failure.
const fakeFetch = (status: number, body: Uint8Array | string) => {
	const seen: SeenRequest[] = [];
	const fn = (async (url: string | URL | Request, init?: RequestInit) => {
		seen.push({
			url: String(url),
			headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
			body: String(init?.body),
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

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]); // "ID3" head
const options = { voice: "", lang: "", outputFormat: "mp3" };
const cfg = {
	kind: "openrouter" as const,
	model: "fish-audio/s2.1-pro-free:free",
	auth: "openrouter",
};

describe("openrouterSpeech", () => {
	test("posts the speech request and returns the raw audio bytes", async () => {
		const { fn, last } = fakeFetch(200, MP3);
		const synth = openrouterSpeech(cfg, auth, { fetchFn: fn });
		const audio = await synth("Say the thing.", options);
		expect(audio).toEqual(MP3);
		const req = last();
		expect(req.url).toBe("https://openrouter.ai/api/v1/audio/speech");
		expect(req.headers.authorization).toBe("Bearer test-key-material");
		expect(req.headers["content-type"]).toBe("application/json");
		const body = JSON.parse(req.body) as {
			model: string;
			input: string;
			voice?: string;
			response_format: string;
		};
		expect(body).toEqual({
			model: "fish-audio/s2.1-pro-free:free",
			input: "Say the thing.",
			response_format: "mp3",
		});
	});

	test("a configured voice rides the body; empty asks for the default", async () => {
		const { fn, last } = fakeFetch(200, MP3);
		const synth = openrouterSpeech({ ...cfg, voice: "b347db033a6549378b48d00acb0d06cd" }, auth, {
			fetchFn: fn,
		});
		await synth("hi", { ...options, voice: "b347db033a6549378b48d00acb0d06cd" });
		expect(JSON.parse(last().body)).toMatchObject({ voice: "b347db033a6549378b48d00acb0d06cd" });
		await synth("hi", options);
		expect(JSON.parse(last().body).voice).toBeUndefined();
	});

	test("the pinned error envelope renders as a loud, named error", async () => {
		const { fn } = fakeFetch(
			429,
			JSON.stringify({
				error: {
					code: 429,
					message:
						"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
				},
			}),
		);
		const synth = openrouterSpeech(cfg, auth, { fetchFn: fn });
		await expect(synth("hi", options)).rejects.toThrow(
			"openrouter: HTTP 429 — Rate limit exceeded: free-models-per-day",
		);
	});

	test("a 200 with no bytes fails loud", async () => {
		const { fn } = fakeFetch(200, "");
		const synth = openrouterSpeech(cfg, auth, { fetchFn: fn });
		await expect(synth("hi", options)).rejects.toThrow("openrouter: empty audio response");
	});

	test("a resolve failure propagates before the wire", async () => {
		const { fn, seen } = fakeFetch(200, MP3);
		const synth = openrouterSpeech({ ...cfg, auth: "gone" }, auth, { fetchFn: fn });
		await expect(synth("hi", options)).rejects.toThrow("no such secret: gone");
		expect(seen.length).toBe(0);
	});
});

describe("synthesizeSpeech openrouter dispatch", () => {
	test("chunks flow through the cloud synth to the mp3 remux", async () => {
		const { fn, last } = fakeFetch(200, MP3);
		const remuxed: Uint8Array[] = [];
		const audio = await synthesizeSpeech("One sentence. Two sentence.", cfg, {
			auth,
			fetchFn: fn,
			chunkLimit: 15,
			remux: async (bytes) => {
				remuxed.push(bytes);
				return new Uint8Array([79, 103, 103, 83]);
			},
		});
		expect(audio).toHaveLength(2);
		expect(remuxed).toEqual([MP3, MP3]);
		expect(JSON.parse(last().body).input).toBe("Two sentence.");
	});

	test("no auth store fails loud, not at the wire", async () => {
		const { fn, seen } = fakeFetch(200, MP3);
		await expect(synthesizeSpeech("hi", cfg, { fetchFn: fn })).rejects.toThrow(
			"openrouter tts needs an auth store",
		);
		expect(seen.length).toBe(0);
	});
});
