import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStore } from "../../auth.ts";
import type { Config, ConfigRef } from "../../config.ts";
import { paths } from "../../config.ts";
import { imageTool, type ImageToolDeps } from "./image.ts";
import { DeliveryUncertainError, type OutgoingFile } from "./send.ts";

const opts = { toolCallId: "t1", messages: [], context: {} };

const auth: AuthStore = {
	resolve: async (name) => `key-for-${name}`,
	has: () => true,
	names: () => ["logfare"],
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const okBody = JSON.stringify({
	data: [{ b64_json: Buffer.from(PNG).toString("base64") }],
});

const fakeFetch = (status: number, body: string) => {
	const seen: { url: string; body: string; signal?: AbortSignal | null | undefined }[] = [];
	const fn = (async (url: string | URL | Request, init?: RequestInit) => {
		seen.push({ url: String(url), body: String(init?.body), signal: init?.signal });
		return new Response(body, { status });
	}) as typeof fetch;
	return { fn, seen };
};

function cfg(): Config {
	return {
		providers: {
			logfare: { kind: "openai-compatible", baseUrl: "https://logfare.ai/v1", auth: "logfare" },
		},
		model: "zai/glm-5.3-flash",
		tts: false,
		favorites: [],
		thinking: "medium",
		operators: [1],
		allowedUsers: [1],
		telegram: { dmGapMinutes: 45, richReplies: true, showReasoning: false },
		http: { port: 8787 },
		logLevel: "info",
		image: { model: "logfare/flux-2-dev" },
	};
}

function deps(
	fetchFn: typeof fetch,
	deliver?: (file: OutgoingFile) => Promise<void>,
): ImageToolDeps {
	return {
		configRef: { current: cfg(), ttsDown: false },
		auth,
		conversation: "c1",
		fetchFn,
		...(deliver !== undefined ? { deliver } : {}),
	};
}

let prevHome: string | undefined;
let dirs: string[] = [];
beforeEach(() => {
	prevHome = process.env.GOBLIN_HOME;
	const dir = mkdtempSync(join(tmpdir(), "goblin-img-"));
	dirs.push(dir);
	process.env.GOBLIN_HOME = dir;
});
afterEach(() => {
	if (prevHome === undefined) delete process.env.GOBLIN_HOME;
	else process.env.GOBLIN_HOME = prevHome;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

describe("generate_image tool", () => {
	test("generates, persists under the attachments dir, and delivers", async () => {
		const { fn, seen } = fakeFetch(200, okBody);
		const sent: OutgoingFile[] = [];
		const out = (await imageTool(deps(fn, async (f) => void sent.push(f))).execute!(
			{ prompt: "a goblin reading a newspaper" },
			opts,
		)) as {
			images: { path: string; filename: string; bytes: number; mediaType: string; delivered: boolean }[];
			delivered: number;
			model: string;
		};
		expect(out.images).toHaveLength(1);
		const img = out.images[0]!;
		expect(img.filename).toBe("image.png");
		expect(img.mediaType).toBe("image/png");
		expect(img.bytes).toBe(PNG.byteLength);
		expect(img.delivered).toBe(true);
		expect(out.delivered).toBe(1);
		expect(out.model).toBe("logfare/flux-2-dev");
		// Durable write under $GOBLIN_HOME/state/attachments — the same
		// store intake media lands in, so vision/send_file can reach it.
		expect(img.path.startsWith(paths.attachments())).toBe(true);
		expect(readdirSync(paths.attachments())).toHaveLength(1);
		expect(sent).toEqual([
			{ path: img.path, filename: "image.png", caption: "a goblin reading a newspaper" },
		]);
		expect(JSON.parse(seen[0]!.body).prompt).toBe("a goblin reading a newspaper");
	});

	test("no delivery sink still saves and reports the path", async () => {
		const { fn } = fakeFetch(200, okBody);
		const out = (await imageTool(deps(fn)).execute!({ prompt: "x" }, opts)) as {
			images: { path: string; delivered: boolean }[];
			delivered: number;
		};
		expect(out.images[0]?.delivered).toBe(false);
		expect(out.delivered).toBe(0);
		expect(readdirSync(paths.attachments())).toHaveLength(1);
	});

	test("a provider error surfaces as a tool error — nothing saved, nothing sent", async () => {
		const { fn } = fakeFetch(
			400,
			JSON.stringify({ error: { message: "unknown model", code: "invalid_model" } }),
		);
		const sent: OutgoingFile[] = [];
		const out = (await imageTool(deps(fn, async (f) => void sent.push(f))).execute!(
			{ prompt: "x" },
			opts,
		)) as { error?: string };
		expect(out.error).toContain("image generation failed: Error: image: HTTP 400 — unknown model");
		expect(sent).toHaveLength(0);
		expect(existsSync(paths.attachments())).toBe(false);
	});

	test("an uncertain delivery reports the saved file, never a resend", async () => {
		const { fn } = fakeFetch(200, okBody);
		const out = (await imageTool(
			deps(fn, async () => {
				throw new DeliveryUncertainError(new Error("sendPhoto timed out"));
			}),
		).execute!({ prompt: "x" }, opts)) as {
			images: { delivered: boolean; deliveryNote?: string }[];
			delivered: number;
		};
		expect(out.images[0]?.delivered).toBe(false);
		expect(out.images[0]?.deliveryNote).toContain("delivery uncertain");
		expect(out.delivered).toBe(0);
		expect(readdirSync(paths.attachments())).toHaveLength(1);
	});

	test("the turn's abort signal reaches the provider wire", async () => {
		const controller = new AbortController();
		const { fn, seen } = fakeFetch(200, okBody);
		await imageTool(deps(fn)).execute!(
			{ prompt: "x" },
			{ ...opts, abortSignal: controller.signal },
		);
		expect(seen[0]?.signal?.aborted).toBe(false);
		controller.abort();
		expect(seen[0]?.signal?.aborted).toBe(true);
	});

	test("n images name and deliver independently", async () => {
		const two = JSON.stringify({
			data: [
				{ b64_json: Buffer.from(PNG).toString("base64") },
				{ b64_json: Buffer.from(PNG).toString("base64") },
			],
		});
		const { fn } = fakeFetch(200, two);
		const sent: OutgoingFile[] = [];
		const out = (await imageTool(deps(fn, async (f) => void sent.push(f))).execute!(
			{ prompt: "two goblins", n: 2 },
			opts,
		)) as { images: { filename: string }[]; delivered: number };
		expect(out.images.map((i) => i.filename)).toEqual(["image-1.png", "image-2.png"]);
		expect(out.delivered).toBe(2);
		expect(sent.map((f) => f.filename)).toEqual(["image-1.png", "image-2.png"]);
	});
});
