import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whistleEngine, type WhistleDeps } from "./transcribe-whistle.ts";

let dirs: string[] = [];
function tmpdir_(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-whistle-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

// A stub engine binary — a bun script speaking the pinned CLI contract
// (one JSON line on stdout; exit 1 + one-line stderr on failure). Mode
// echoes the keywords file contents and the forced language into the
// transcript so the argv wiring is asserted end to end.
type StubMode = "ok" | "silence" | "fail" | "garbage";
function stubEngine(dir: string, mode: StubMode): string {
	const path = join(dir, `stub-${mode}.mjs`);
	const script = `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const audio = flag("--audio");
if (!audio || flag("--model") === null) { console.error("usage: needle [--model] [--audio]"); process.exit(1); }
const kwFile = flag("--audio-keywords");
const lang = flag("--audio-language");
const kw = kwFile === null ? "" : readFileSync(kwFile, "utf8").trim().replaceAll("\\n", "+");
${
	mode === "ok"
		? `process.stdout.write(JSON.stringify({ text: "hola goblin" + (kw ? " kw:" + kw : "") + (lang ? " lang:" + lang : ""), language: "es", ttft_ms: 120, decode_tps: 81.4 }));`
		: mode === "silence"
			? `process.stdout.write(JSON.stringify({ text: "", language: "" }));`
			: mode === "fail"
				? `console.error("audio limit is 30 s"); process.exit(1);`
				: `process.stdout.write("definitely not json");`
}
`;
	writeFileSync(path, script);
	chmodSync(path, 0o755);
	return path;
}

function weightsStub(dir: string): string {
	const path = join(dir, "whistle.cact");
	writeFileSync(path, "fake-weights");
	return path;
}

// Deps that never touch the network or the real cache: overrides for
// both artifacts and a fetch that must not be called.
const offlineDeps = (engine: string, weights: string): WhistleDeps => ({
	fetchFn: (() => {
		throw new Error("fetch must not be called when both artifacts are overridden");
	}) as unknown as typeof fetch,
});

function audioFile(dir: string): { path: string; mediaType: string; filename: string } {
	const path = join(dir, "seg_0000.wav");
	writeFileSync(path, "RIFF-not-really");
	return { path, mediaType: "audio/wav", filename: "seg_0000.wav" };
}

describe("whistleEngine", () => {
	test("prep is 16 kHz mono wav at 28 s segments; no upload cap", () => {
		const dir = tmpdir_();
		const engine = whistleEngine(
			{ engine: stubEngine(dir, "ok"), weights: weightsStub(dir) },
			offlineDeps("", ""),
		);
		expect(engine.prep).toEqual({ container: "wav", sampleRateHz: 16_000, mono: true });
		expect(engine.limits).toEqual({ maxSeconds: 28 });
		expect(engine.id).toBe("whistle");
	});

	test("returns the engine's transcript with its language", async () => {
		const dir = tmpdir_();
		const engine = whistleEngine(
			{ engine: stubEngine(dir, "ok"), weights: weightsStub(dir) },
			offlineDeps("", ""),
		);
		const result = await engine.transcribe(audioFile(dir));
		expect(result).toEqual({ text: "hola goblin", language: "es" });
	});

	test("keywords ride a one-per-line temp file; language is forced", async () => {
		const dir = tmpdir_();
		const engine = whistleEngine(
			{
				engine: stubEngine(dir, "ok"),
				weights: weightsStub(dir),
				keywords: ["goblin", "bermudi"],
				language: "es",
			},
			offlineDeps("", ""),
		);
		const result = await engine.transcribe(audioFile(dir));
		expect(result.text).toBe("hola goblin kw:goblin+bermudi lang:es");
	});

	test("silence is the engine's empty text — the orchestrator's null", async () => {
		const dir = tmpdir_();
		const engine = whistleEngine(
			{ engine: stubEngine(dir, "silence"), weights: weightsStub(dir) },
			offlineDeps("", ""),
		);
		expect(await engine.transcribe(audioFile(dir))).toEqual({ text: "" });
	});

	test("engine failure: exit 1's stderr reaches the caller", async () => {
		const dir = tmpdir_();
		const engine = whistleEngine(
			{ engine: stubEngine(dir, "fail"), weights: weightsStub(dir) },
			offlineDeps("", ""),
		);
		await expect(engine.transcribe(audioFile(dir))).rejects.toThrow(
			"whistle: engine exited 1 — audio limit is 30 s",
		);
	});

	test("non-JSON stdout fails loud", async () => {
		const dir = tmpdir_();
		const engine = whistleEngine(
			{ engine: stubEngine(dir, "garbage"), weights: weightsStub(dir) },
			offlineDeps("", ""),
		);
		await expect(engine.transcribe(audioFile(dir))).rejects.toThrow("stdout is not JSON");
	});

	test("a language outside the engine's set is a config error", () => {
		const dir = tmpdir_();
		expect(() =>
			whistleEngine(
				{ engine: stubEngine(dir, "ok"), weights: weightsStub(dir), language: "ja" },
				offlineDeps("", ""),
			),
		).toThrow('language "ja" not in its set');
	});

	test("a missing configured artifact fails loud", async () => {
		const dir = tmpdir_();
		const engine = whistleEngine(
			{ engine: join(dir, "no-such-needle"), weights: weightsStub(dir) },
			offlineDeps("", ""),
		);
		await expect(engine.transcribe(audioFile(dir))).rejects.toThrow(
			"configured artifact not found",
		);
	});
});

describe("whistle artifact auto-fetch", () => {
	// Fake digests so fixtures can serve a few bytes instead of the
	// real 18 MB artifacts.
	const fakeDigest = (data: string): string => Bun.CryptoHasher.hash("sha256", data, "hex");

	test("fetches each artifact once into the cache, then reuses", async () => {
		const dir = tmpdir_();
		const cache = join(dir, "cache");
		// The "downloaded" engine is the stub script itself — shebang'd,
		// so executing the fetched file runs the pinned contract.
		const stubBytes = readFileSync(stubEngine(dir, "ok"), "utf8");
		const fetches: string[] = [];
		const deps: WhistleDeps = {
			cacheDir: cache,
			arch: "x64",
			platform: "linux",
			digests: { engine: fakeDigest(stubBytes), weights: fakeDigest("weights-bytes") },
			fetchFn: (async (url: string | URL | Request) => {
				const u = String(url);
				fetches.push(u);
				return new Response(u.endsWith("/needle") ? stubBytes : "weights-bytes");
			}) as unknown as typeof fetch,
		};
		const f = audioFile(dir);
		// Second engine on the same cache: memoized artifacts, no fetch.
		const r1 = await whistleEngine({}, deps).transcribe(f);
		const r2 = await whistleEngine({}, deps).transcribe(f);
		expect(r1.text).toBe("hola goblin");
		expect(r2.text).toBe("hola goblin");
		expect(fetches.length).toBe(2);
		expect(existsSync(join(cache, "needle"))).toBe(true);
		expect(readFileSync(join(cache, "whistle.cact"), "utf8")).toBe("weights-bytes");
		expect((statSync(join(cache, "needle")).mode & 0o111) !== 0).toBe(true);
	});

	test("a digest mismatch fails loud and caches nothing", async () => {
		const dir = tmpdir_();
		const cache = join(dir, "cache");
		const deps: WhistleDeps = {
			cacheDir: cache,
			arch: "x64",
			platform: "linux",
			// Declared digests describe the pinned files; the server
			// answers something else — supply-chain drift.
			digests: { engine: fakeDigest("engine-bytes"), weights: fakeDigest("weights-bytes") },
			fetchFn: (async (url: string | URL | Request) =>
				new Response(String(url).endsWith("/needle") ? "tampered-engine" : "tampered-weights", {
					status: 200,
				})) as typeof fetch,
		};
		const engine = whistleEngine({}, deps);
		await expect(engine.transcribe(audioFile(dir))).rejects.toThrow("digest mismatch");
		expect(existsSync(join(cache, "needle"))).toBe(false);
	});

	test("an unmapped platform errors with the manual-path instruction", async () => {
		const dir = tmpdir_();
		const engine = whistleEngine(
			{},
			{
				arch: "arm64",
				platform: "darwin",
				cacheDir: join(dir, "cache"),
				fetchFn: (async () => {
					throw new Error("must not fetch");
				}) as unknown as typeof fetch,
			},
		);
		await expect(engine.transcribe(audioFile(dir))).rejects.toThrow(
			"no verified prebuilt engine for darwin-arm64",
		);
	});

	test("overrides bypass the platform gate on an unmapped platform", async () => {
		const dir = tmpdir_();
		// Both artifacts overridden: the fetcher must never resolve
		// URLs (which throw off linux-x64), let alone call fetch.
		const engine = whistleEngine(
			{ engine: stubEngine(dir, "ok"), weights: weightsStub(dir) },
			{
				arch: "arm64",
				platform: "darwin",
				cacheDir: join(dir, "cache"),
				fetchFn: (async () => {
					throw new Error("must not fetch");
				}) as unknown as typeof fetch,
			},
		);
		expect((await engine.transcribe(audioFile(dir))).text).toBe("hola goblin");
	});

	test("a single override still gates the platform for the other artifact", async () => {
		const dir = tmpdir_();
		const engine = whistleEngine(
			{ engine: stubEngine(dir, "ok") },
			{
				arch: "arm64",
				platform: "darwin",
				cacheDir: join(dir, "cache"),
				fetchFn: (async () => {
					throw new Error("must not fetch");
				}) as unknown as typeof fetch,
			},
		);
		// The weights half has no override — its URL resolution throws.
		await expect(engine.transcribe(audioFile(dir))).rejects.toThrow(
			"no verified prebuilt engine for darwin-arm64",
		);
	});
});
