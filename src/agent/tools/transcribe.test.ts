import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { makeTools } from "./mod.ts";
import { readFileTool } from "./read.ts";
import { transcribeTool, wrapTranscript } from "./transcribe.ts";
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

	test("a long transcript returns head and tail, and names the file holding all of it", async () => {
		const dir = workdir();
		writeFileSync(join(dir, "talk.mp3"), "mp3-bytes");
		const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} of the talk`);
		const full = lines.join("\n");
		const t = transcribeTool(dir, async () => full);
		const out = (await t.execute!({ path: "talk.mp3" }, opts)) as {
			transcript: string;
			truncated?: boolean;
		};
		expect(out.truncated).toBe(true);
		expect(out.transcript.length).toBeLessThan(16_000);
		expect(out.transcript).toContain("line 0 of the talk");
		expect(out.transcript).toContain("line 3999 of the talk");
		expect(out.transcript).not.toContain("line 2000 of the talk");
		const saved = /saved to: (\S+)/.exec(out.transcript)![1]!;
		expect(readFileSync(saved, "utf-8")).toBe(full);
	});

	test("a long single-line transcript spills into readable pages", async () => {
		const dir = workdir();
		writeFileSync(join(dir, "whistle.mp3"), "mp3-bytes");
		const full = Array.from({ length: 3584 }, () => "words").join(" ");
		const t = transcribeTool(dir, async () => full);
		const out = (await t.execute!({ path: "whistle.mp3" }, opts)) as {
			transcript: string;
			truncated?: boolean;
		};
		expect(out.truncated).toBe(true);
		const saved = /saved to: (\S+)/.exec(out.transcript)![1]!;
		const spilled = readFileSync(saved, "utf-8");
		const lines = spilled.split("\n");
		expect(lines.every((line) => line.length <= 500)).toBe(true);
		expect(lines.join(" ")).toBe(full);

		const read = readFileTool(dirname(saved));
		const page = (await read.execute!({ path: basename(saved), offset: 2 }, opts)) as {
			content?: string;
			error?: string;
		};
		expect(page.error).toBeUndefined();
		expect(page.content).toContain("2\t");
		expect(page.content).not.toContain("beyond end of file");
	});

	test("a long no-space transcript wraps by Unicode code point", async () => {
		const full = "字".repeat(3000);
		const lines = wrapTranscript(full).split("\n");
		expect(lines.every((line) => Array.from(line).length <= 500)).toBe(true);
		expect(lines.join("")).toBe(full);
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
