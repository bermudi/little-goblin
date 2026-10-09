import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStore } from "../auth.ts";
import { groqEngine } from "./transcribe-cloud.ts";

const auth: AuthStore = {
	resolve: async (name) => {
		if (name === "groq") return "test-key-material";
		throw new Error(`no such secret: ${name}`);
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
