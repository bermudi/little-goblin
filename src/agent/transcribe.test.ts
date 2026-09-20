import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptionModelV2 } from "@ai-sdk/provider";
import type { AuthStore } from "../auth.ts";
import { transcribeAudio, transcriptionModel } from "./transcribe.ts";

let dirs: string[] = [];
function tmpdir_(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-tr-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const fakeModel = (text: string, calls?: { n: number }): TranscriptionModelV2 => ({
	specificationVersion: "v2",
	provider: "test",
	modelId: "fake-whisper",
	doGenerate: async () => {
		if (calls) calls.n += 1;
		return {
			text,
			segments: [],
			language: "en",
			durationInSeconds: 1.5,
			warnings: [],
			response: { timestamp: new Date(), modelId: "fake-whisper" },
		};
	},
});

const file = (path: string): { path: string; mediaType: string; filename: string } => ({
	path,
	mediaType: "audio/ogg",
	filename: "v.ogg",
});

describe("transcribeAudio", () => {
	test("returns the trimmed transcript", async () => {
		const dir = tmpdir_();
		const f = join(dir, "v.ogg");
		writeFileSync(f, "oggdata");
		expect(await transcribeAudio(fakeModel("  call me back  "), file(f))).toBe(
			"call me back",
		);
	});

	test("silence (empty transcript) → null", async () => {
		const dir = tmpdir_();
		const f = join(dir, "v.ogg");
		writeFileSync(f, "oggdata");
		expect(await transcribeAudio(fakeModel("   "), file(f))).toBeNull();
	});

	test("over-cap media is segmented by ffmpeg and joined", async () => {
		if (Bun.which("ffmpeg") === null) return; // environment dep
		const dir = tmpdir_();
		const src = join(dir, "long.ogg");
		// 25s of audio → 3 segments at a shrunken 10s split. A 1-byte cap
		// forces the segment path without a real 25MiB fixture.
		const gen = Bun.spawnSync([
			"ffmpeg", "-hide_banner", "-loglevel", "error",
			"-f", "lavfi", "-i", "sine=frequency=440:duration=25",
			"-ac", "1", "-b:a", "48k", src,
		]);
		if (gen.exitCode !== 0) throw new Error(`test audio gen: ${gen.stderr.toString()}`);
		let n = 0;
		const model: TranscriptionModelV2 = {
			specificationVersion: "v2",
			provider: "test",
			modelId: "fake-whisper",
			doGenerate: async () => ({
				text: `chunk-${++n}`,
				segments: [],
				language: "en",
				durationInSeconds: 1,
				warnings: [],
				response: { timestamp: new Date(), modelId: "fake-whisper" },
			}),
		};
		expect(
			await transcribeAudio(model, file(src), { maxBytes: 1, segmentSeconds: 10 }),
		).toBe("chunk-1 chunk-2 chunk-3");
		expect(n).toBe(3);
	});

	test("a corrupt source fails loud through ffmpeg", async () => {
		if (Bun.which("ffmpeg") === null) return;
		const f = join(tmpdir_(), "junk.ogg");
		writeFileSync(f, "definitely not audio");
		await expect(
			transcribeAudio(fakeModel("x"), file(f), { maxBytes: 1 }),
		).rejects.toThrow("ffmpeg");
	});

	test("a missing file fails loud", async () => {
		await expect(
			transcribeAudio(fakeModel("x"), file(join(tmpdir_(), "gone.ogg"))),
		).rejects.toThrow();
	});
});

describe("transcriptionModel", () => {
	test("groq resolves its auth ref and builds the named model", async () => {
		const resolved: string[] = [];
		const auth: AuthStore = {
			resolve: async (name) => {
				resolved.push(name);
				return "key";
			},
			has: () => true,
			names: () => [],
		};
		const model = await transcriptionModel(
			{ kind: "groq", model: "whisper-large-v3", auth: "groq" },
			auth,
		);
		expect(resolved).toEqual(["groq"]);
		expect(model.modelId).toBe("whisper-large-v3");
	});
});
