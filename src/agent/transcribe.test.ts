import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptionModelV2 } from "@ai-sdk/provider";
import type { AuthStore } from "../auth.ts";
import { transcribeAudio, transcriptionModel, TRANSCRIBE_MAX_BYTES } from "./transcribe.ts";

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

	test("a file over the provider cap is skipped without calling the model", async () => {
		const dir = tmpdir_();
		const f = join(dir, "big.ogg");
		writeFileSync(f, "x");
		truncateSync(f, TRANSCRIBE_MAX_BYTES + 1);
		const calls = { n: 0 };
		expect(await transcribeAudio(fakeModel("x", calls), file(f))).toBeNull();
		expect(calls.n).toBe(0);
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
