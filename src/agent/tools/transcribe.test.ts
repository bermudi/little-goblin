import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTools } from "./mod.ts";
import { transcribeTool } from "./transcribe.ts";
import type { SpeechFile } from "../transcribe.ts";

const dirs: string[] = [];
const opts = { toolCallId: "t1", messages: [], context: {} };

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

function workdir(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-tr-"));
	dirs.push(dir);
	return dir;
}

describe("transcribe", () => {
	test("is absent without transcription deps wired", () => {
		expect(makeTools({ cwd: "/tmp" }).transcribe).toBeUndefined();
	});

	test("hands the resolved file to the provider seam and returns the transcript", async () => {
		const dir = workdir();
		writeFileSync(join(dir, "podcast.mp3"), "mp3-bytes");
		const seen: SpeechFile[] = [];
		const t = transcribeTool(dir, async (f) => {
			seen.push(f);
			return "hello world";
		});
		const out = await t.execute!({ path: "podcast.mp3" }, opts);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.path).toBe(join(dir, "podcast.mp3"));
		expect(seen[0]!.filename).toBe("podcast.mp3");
		expect(out).toEqual({ transcript: "hello world" });
	});

	test("a missing file is an error result, not a throw", async () => {
		const t = transcribeTool(workdir(), async () => "x");
		const out = (await t.execute!({ path: "nope.mp3" }, opts)) as { error?: string };
		expect(out.error).toContain("file not found");
	});

	test("a directory is an error result", async () => {
		const dir = workdir();
		const t = transcribeTool(dir, async () => "x");
		const out = (await t.execute!({ path: "." }, opts)) as { error?: string };
		expect(out.error).toContain("is a directory");
	});

	test("no speech found is an error result naming the cause", async () => {
		const dir = workdir();
		writeFileSync(join(dir, "song.mp3"), "mp3-bytes");
		const t = transcribeTool(dir, async () => null);
		const out = (await t.execute!({ path: "song.mp3" }, opts)) as { error?: string };
		expect(out.error).toContain("no transcript produced");
	});

	test("a provider failure degrades to an error result, never a throw", async () => {
		const dir = workdir();
		writeFileSync(join(dir, "v.ogg"), "ogg-bytes");
		const t = transcribeTool(dir, async () => {
			throw new Error("whisper down");
		});
		const out = (await t.execute!({ path: "v.ogg" }, opts)) as { error?: string };
		expect(out.error).toContain("whisper down");
	});
});
