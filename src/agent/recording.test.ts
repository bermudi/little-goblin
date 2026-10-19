import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../testkit.ts";
import { normalizeRecordedAudio } from "./recording.ts";

// MediaRecorder's signature fixture: muxing to a non-seekable pipe
// writes an unbounded segment — Duration absent, exactly like the
// browser's recorder output. `inflate` adds the timestamp lie
// (pts 400x wall time, the Chromium monotonic-clock bug's shape).
function genUnbounded(seconds: number, inflate = false): Uint8Array {
	const gen = Bun.spawnSync([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:duration=${seconds}`,
		...(inflate ? ["-af", "asetpts=PTS*400"] : []),
		"-c:a",
		"libopus",
		"-f",
		"webm",
		"pipe:1",
	]);
	if (gen.exitCode !== 0) throw new Error(`unbounded webm gen: ${gen.stderr.toString()}`);
	return gen.stdout;
}

// A real video: picture + audio on an unbounded segment. The gate
// must never touch it — normalization would strip the video track.
function genUnboundedVideo(dest: string): void {
	const gen = Bun.spawnSync([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc=duration=1:size=64x64:rate=10",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=1",
		"-c:v",
		"libvpx",
		"-c:a",
		"libopus",
		"-f",
		"webm",
		dest,
	]);
	if (gen.exitCode !== 0) throw new Error(`video gen: ${gen.stderr.toString()}`);
}

function genBounded(dest: string, seconds: number): void {
	const gen = Bun.spawnSync([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:duration=${seconds}`,
		"-c:a",
		"libopus",
		dest,
	]);
	if (gen.exitCode !== 0) throw new Error(`webm gen: ${gen.stderr.toString()}`);
}

function declaredDuration(path: string): number | null {
	const r = Bun.spawnSync([
		"ffprobe",
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"default=noprint_wrappers=1:nokey=1",
		path,
	]);
	const d = Number.parseFloat(r.stdout.toString().trim());
	return Number.isFinite(d) ? d : null;
}

const toolsPresent = () => Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

describe("normalizeRecordedAudio", () => {
	test("a non-media claim is left alone, no probe", async () => {
		const dir = tmpDir("goblin-rec-");
		const f = join(dir, "note.txt");
		writeFileSync(f, "not media at all");
		const r = await normalizeRecordedAudio(f, "text/plain");
		expect(r).toEqual({ fixed: false, mediaType: "text/plain" });
		expect(readFileSync(f).toString()).toBe("not media at all");
	});

	test("an unbounded recorder container gains a real duration", async () => {
		if (!toolsPresent()) return; // environment dep
		const dir = tmpDir("goblin-rec-");
		const f = join(dir, "voice-note.webm");
		writeFileSync(f, genUnbounded(3));
		expect(declaredDuration(f)).toBeNull();
		const r = await normalizeRecordedAudio(f, "audio/webm;codecs=opus");
		expect(r.fixed).toBe(true);
		const d = declaredDuration(f);
		expect(d).not.toBeNull();
		expect(d!).toBeGreaterThan(2);
		expect(d!).toBeLessThan(5);
	});

	test("inflated packet pts is rebuilt from sample count", async () => {
		if (!toolsPresent()) return; // environment dep
		const dir = tmpDir("goblin-rec-");
		const f = join(dir, "voice-note.webm");
		// 3 s of audio on a ~20-minute timeline — the recorded
		// pathology's shape (uptime-base pts), exaggerated.
		writeFileSync(f, genUnbounded(3, true));
		const r = await normalizeRecordedAudio(f, "audio/webm");
		expect(r.fixed).toBe(true);
		const d = declaredDuration(f);
		expect(d).not.toBeNull();
		expect(d!).toBeLessThan(5);
	});

	test("the extension-sniffed video/webm claim is corrected to audio/webm", async () => {
		if (!toolsPresent()) return; // environment dep
		const dir = tmpDir("goblin-rec-");
		const f = join(dir, "voice-note.webm");
		writeFileSync(f, genUnbounded(2));
		// What Bun's formData reports for a browser webm voice note.
		const r = await normalizeRecordedAudio(f, "video/webm");
		expect(r).toEqual({ fixed: true, mediaType: "audio/webm" });
		expect(declaredDuration(f)).not.toBeNull();
	});

	test("a healthy container keeps its bytes", async () => {
		if (!toolsPresent()) return; // environment dep
		const dir = tmpDir("goblin-rec-");
		const f = join(dir, "voice-note.webm");
		genBounded(f, 2);
		const before = readFileSync(f);
		const r = await normalizeRecordedAudio(f, "audio/webm");
		expect(r.fixed).toBe(false);
		expect(readFileSync(f)).toEqual(before);
	});

	test("a real video keeps its bytes even when unbounded", async () => {
		if (!toolsPresent()) return; // environment dep
		const dir = tmpDir("goblin-rec-");
		const f = join(dir, "clip.webm");
		genUnboundedVideo(f);
		const before = readFileSync(f);
		const r = await normalizeRecordedAudio(f, "video/webm");
		expect(r).toEqual({ fixed: false, mediaType: "video/webm" });
		expect(readFileSync(f)).toEqual(before);
	});

	test("an unparseable upload throws so the caller can keep it verbatim", async () => {
		const dir = tmpDir("goblin-rec-");
		const f = join(dir, "voice-note.webm");
		writeFileSync(f, "garbage");
		await expect(normalizeRecordedAudio(f, "audio/webm")).rejects.toThrow();
	});
});
