import { describe, expect, test } from "bun:test";
import type { AuthStore } from "../auth.ts";
import type { Config, ConfigRef } from "../config.ts";
import { generateImages } from "./image.ts";

const auth: AuthStore = {
	resolve: async (name) => {
		if (name === "gone") throw new Error("no such secret: gone");
		return `key-for-${name}`;
	},
	has: () => true,
	names: () => ["logfare"],
};

// The documented images response shape — data:[{b64_json}]. Pinned
// from logfare's docs (https://logfare.ai/docs, OpenAI-compatible);
// unverified live until an operator provisions a logfare auth record.
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const okBody = (items: number) =>
	JSON.stringify({
		created: 1791572519,
		data: Array.from({ length: items }, () => ({
			b64_json: Buffer.from(PNG_HEAD).toString("base64"),
		})),
	});

interface SeenRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
	signal?: AbortSignal | null | undefined;
}

const fakeFetch = (status: number, body: string | Uint8Array) => {
	const seen: SeenRequest[] = [];
	const fn = (async (url: string | URL | Request, init?: RequestInit) => {
		seen.push({
			url: String(url),
			headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
			body: String(init?.body),
			signal: init?.signal,
		});
		return new Response(body, { status });
	}) as typeof fetch;
	return {
		fn,
		seen,
		last: () => {
			const req = seen.at(-1);
			if (req === undefined) throw new Error("fake fetch saw no request");
			return req;
		},
	};
};

function cfgRef(image?: Config["image"]): ConfigRef {
	const cfg: Config = {
		providers: {
			logfare: {
				kind: "openai-compatible",
				baseUrl: "https://logfare.ai/v1",
				auth: "logfare",
			},
			or: { kind: "openrouter", auth: "openrouter" },
		},
		model: "zai/glm-5.3-flash",
		tts: false,
		favorites: [],
		thinking: "medium",
		operators: [1],
		allowedUsers: [1],
		telegram: { enabled: true, dmGapMinutes: 45, richReplies: true, showReasoning: false },
		http: { port: 8787 },
		logLevel: "info",
		...(image !== undefined ? { image } : {}),
	};
	return { current: cfg, ttsDown: false };
}

const imageCfg = { model: "logfare/flux-2-dev", size: "1024x768" };

describe("generateImages", () => {
	test("posts the OpenAI images shape to the provider's baseUrl", async () => {
		const { fn, last } = fakeFetch(200, okBody(1));
		const images = await generateImages(
			{ prompt: "a goblin reading a newspaper" },
			{ configRef: cfgRef(imageCfg), auth, conversation: "c1", fetchFn: fn },
		);
		expect(images).toHaveLength(1);
		expect(images[0]?.mediaType).toBe("image/png");
		expect(images[0]?.ext).toBe("png");
		expect(images[0]?.bytes).toEqual(PNG_HEAD);
		const req = last();
		expect(req.url).toBe("https://logfare.ai/v1/images/generations");
		expect(req.headers.authorization).toBe("Bearer key-for-logfare");
		// The model id is the ref's tail — the provider name never rides.
		expect(JSON.parse(req.body)).toEqual({
			model: "flux-2-dev",
			prompt: "a goblin reading a newspaper",
			size: "1024x768",
			response_format: "b64_json",
		});
	});

	test("a per-call size overrides the block default; n>1 decodes every item", async () => {
		const { fn, last } = fakeFetch(200, okBody(3));
		const images = await generateImages(
			{ prompt: "goblins", size: "512x512", n: 3 },
			{
				configRef: cfgRef({ model: "logfare/flux-1-schnell" }),
				auth,
				conversation: "c1",
				fetchFn: fn,
			},
		);
		expect(images).toHaveLength(3);
		expect(JSON.parse(last().body)).toMatchObject({ size: "512x512", n: 3 });
	});

	test("the api error envelope renders with the provider named", async () => {
		const { fn } = fakeFetch(
			400,
			JSON.stringify({ error: { message: "unknown model: flux-nope", code: "invalid_model" } }),
		);
		await expect(
			generateImages(
				{ prompt: "x" },
				{ configRef: cfgRef(imageCfg), auth, conversation: "c1", fetchFn: fn },
			),
		).rejects.toThrow("image: HTTP 400 — unknown model: flux-nope");
	});

	test("a non-JSON success body fails loud with the head", async () => {
		const { fn } = fakeFetch(200, "<html>gateway oops</html>");
		await expect(
			generateImages(
				{ prompt: "x" },
				{ configRef: cfgRef(imageCfg), auth, conversation: "c1", fetchFn: fn },
			),
		).rejects.toThrow("image: response is not JSON");
	});

	test("a url item fails loud — bytes must arrive in-body", async () => {
		const { fn } = fakeFetch(
			200,
			JSON.stringify({ data: [{ url: "https://cdn.example.com/i.png" }] }),
		);
		await expect(
			generateImages(
				{ prompt: "x" },
				{ configRef: cfgRef(imageCfg), auth, conversation: "c1", fetchFn: fn },
			),
		).rejects.toThrow("only b64_json responses are supported");
	});

	test("unrecognized image bytes fail loud — a wrong extension would lie", async () => {
		const { fn } = fakeFetch(
			200,
			JSON.stringify({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }),
		);
		await expect(
			generateImages(
				{ prompt: "x" },
				{ configRef: cfgRef(imageCfg), auth, conversation: "c1", fetchFn: fn },
			),
		).rejects.toThrow("image: unrecognized image bytes");
	});

	test("a provider without baseUrl is refused before the wire", async () => {
		const { fn, seen } = fakeFetch(200, okBody(1));
		await expect(
			generateImages(
				{ prompt: "x" },
				{ configRef: cfgRef({ model: "or/flux-2-dev" }), auth, conversation: "c1", fetchFn: fn },
			),
		).rejects.toThrow('image: provider "or" has no baseUrl');
		expect(seen.length).toBe(0);
	});

	test("a missing auth record propagates before the wire", async () => {
		const ref = cfgRef(imageCfg);
		ref.current.providers["logfare"] = {
			kind: "openai-compatible",
			baseUrl: "https://logfare.ai/v1",
			auth: "gone",
		};
		const { fn, seen } = fakeFetch(200, okBody(1));
		await expect(
			generateImages({ prompt: "x" }, { configRef: ref, auth, conversation: "c1", fetchFn: fn }),
		).rejects.toThrow("no such secret: gone");
		expect(seen.length).toBe(0);
	});

	test("the wire signal aborts with the turn's signal", async () => {
		const controller = new AbortController();
		const { fn, last } = fakeFetch(200, okBody(1));
		await generateImages(
			{ prompt: "x" },
			{
				configRef: cfgRef(imageCfg),
				auth,
				conversation: "c1",
				fetchFn: fn,
				signal: controller.signal,
			},
		);
		// The wire gets the combined turn+timeout signal — prove the
		// turn's half propagates (vision's seam lesson).
		expect(last().signal?.aborted).toBe(false);
		controller.abort();
		expect(last().signal?.aborted).toBe(true);
	});

	test("a stopped turn settles the in-flight call instead of paying for it", async () => {
		const controller = new AbortController();
		// A provider edge that hangs until the wire signal fires — what a
		// real fetch does under /stop.
		const hang = (async (_url: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
				);
			})) as typeof fetch;
		const pending = generateImages(
			{ prompt: "x" },
			{
				configRef: cfgRef(imageCfg),
				auth,
				conversation: "c1",
				fetchFn: hang,
				signal: controller.signal,
				timeoutMs: 5_000,
			},
		);
		setTimeout(() => controller.abort(), 20);
		await expect(pending).rejects.toThrow("image: request failed");
	});
});
