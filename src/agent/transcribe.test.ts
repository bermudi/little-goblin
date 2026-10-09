import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribeAudio, type EngineTranscript, type SpeechEngine } from "./transcribe.ts";

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

// Fake engine: returns canned transcripts and records what it was fed.
const fakeEngine = (
	text: string,
	log?: { calls: { path: string; bytes: Uint8Array }[] },
	prep: SpeechEngine["prep"] = { container: "keep" },
	limits: SpeechEngine["limits"] = { maxBytes: 25 * 1024 * 1024, maxSeconds: 15 * 60 },
): SpeechEngine => ({
	id: "test/fake-whisper",
	limits,
	prep,
	transcribe: async (file) => {
		log?.calls.push({ path: file.path, bytes: readFileSync(file.path) });
		return { text, language: "en" };
	},
});

const keepEngine = (text: string, log?: { calls: { path: string; bytes: Uint8Array }[] }) =>
	fakeEngine(text, log);

const file = (path: string): { path: string; mediaType: string; filename: string } => ({
	path,
	mediaType: "audio/ogg",
	filename: "v.ogg",
});

function genAudio(dest: string, seconds: number): void {
	const gen = Bun.spawnSync([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:duration=${seconds}`,
		"-ac",
		"1",
		"-b:a",
		"48k",
		dest,
	]);
	if (gen.exitCode !== 0) throw new Error(`test audio gen: ${gen.stderr.toString()}`);
}

// Codec name from the start of an Ogg stream: opus pages open with
// "OpusHead", vorbis with "\u0001vorbis", FLAC-in-Ogg with "\u007fFLAC".
function oggCodec(audio: Uint8Array): string {
	const head = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
		.toString("latin1")
		.slice(0, 128);
	if (head.includes("OpusHead")) return "opus";
	if (head.includes("vorbis")) return "vorbis";
	if (head.includes("FLAC")) return "flac";
	return "unknown";
}

// RIFF fmt chunk: channels at byte offset 22, sample rate at 24 — the
// wav profile's 16 kHz mono contract, read where ffmpeg wrote it.
function wavShape(audio: Uint8Array): { channels: number; sampleRate: number } {
	const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
	return { channels: view.getUint16(22, true), sampleRate: view.getUint32(24, true) };
}

describe("transcribeAudio", () => {
	test("returns the trimmed transcript", async () => {
		const dir = tmpdir_();
		const f = join(dir, "v.ogg");
		writeFileSync(f, "oggdata");
		expect(await transcribeAudio(keepEngine("  call me back  "), file(f))).toBe("call me back");
	});

	test("silence (empty transcript) → null", async () => {
		const dir = tmpdir_();
		const f = join(dir, "v.ogg");
		writeFileSync(f, "oggdata");
		expect(await transcribeAudio(keepEngine("   "), file(f))).toBeNull();
	});

	test("over-cap media is segmented to mono opus and joined", async () => {
		if (Bun.which("ffmpeg") === null) return; // environment dep
		const dir = tmpdir_();
		const src = join(dir, "long.ogg");
		// 25s of audio → 3 segments at a shrunken 10s split. A 1-byte cap
		// forces the segment path without a real 25MiB fixture.
		genAudio(src, 25);
		const seen: { path: string; bytes: Uint8Array }[] = [];
		let n = 0;
		const engine: SpeechEngine = {
			id: "test/fake-whisper",
			limits: { maxBytes: 25 * 1024 * 1024, maxSeconds: 15 * 60 },
			prep: { container: "keep" },
			// DESIGN.md mandates mono opus: without -c:a the Ogg segment
			// muxer picks the build's default encoder — libvorbis where
			// present, else FLAC, which ignores -b:a and can re-exceed the
			// 25 MiB upload cap. Sniffing what the engine would upload pins
			// that at the boundary.
			transcribe: async (seg) => {
				n += 1;
				const bytes = readFileSync(seg.path);
				seen.push({ path: seg.path, bytes });
				return { text: `chunk-${n}` };
			},
		};
		expect(await transcribeAudio(engine, file(src), { maxBytes: 1, segmentSeconds: 10 })).toBe(
			"chunk-1 chunk-2 chunk-3",
		);
		expect(n).toBe(3);
		expect(seen.map(({ bytes }) => oggCodec(bytes))).toEqual(["opus", "opus", "opus"]);
	});

	test("the wav profile always segments to 16 kHz mono pcm and joins", async () => {
		if (Bun.which("ffmpeg") === null) return; // environment dep
		const dir = tmpdir_();
		const src = join(dir, "note.ogg");
		genAudio(src, 25);
		const seen: { path: string; bytes: Uint8Array }[] = [];
		let n = 0;
		const engine: SpeechEngine = {
			id: "whistle",
			limits: { maxSeconds: 28 },
			prep: { container: "wav", sampleRateHz: 16_000, mono: true },
			transcribe: async (seg) => {
				n += 1;
				const bytes = readFileSync(seg.path);
				seen.push({ path: seg.path, bytes });
				return { text: `seg-${n}`, language: "en" };
			},
		};
		// No maxBytes to trip — the wav profile transcodes regardless.
		expect(await transcribeAudio(engine, file(src), { segmentSeconds: 10 })).toBe(
			"seg-1 seg-2 seg-3",
		);
		expect(n).toBe(3);
		for (const { path: p, bytes } of seen) {
			expect(p.endsWith(".wav")).toBe(true);
			expect(wavShape(bytes)).toEqual({ channels: 1, sampleRate: 16_000 });
		}
	});

	test("an over-cap outage with nothing transcribed fails loud, never reads as no-speech", async () => {
		if (Bun.which("ffmpeg") === null) return; // environment dep
		const dir = tmpdir_();
		const src = join(dir, "long.ogg");
		genAudio(src, 5);
		const engine: SpeechEngine = {
			id: "test/fake-whisper",
			limits: { maxBytes: 25 * 1024 * 1024, maxSeconds: 15 * 60 },
			prep: { container: "keep" },
			transcribe: async () => {
				throw new Error("whisper is down");
			},
		};
		// A null here would ride the tool's fixed "may contain no
		// speech" string — the provider error must reach the caller.
		await expect(transcribeAudio(engine, file(src), { maxBytes: 1 })).rejects.toThrow(
			"whisper is down",
		);
	});

	test("an over-cap outage mid-stream keeps the segments before it", async () => {
		if (Bun.which("ffmpeg") === null) return; // environment dep
		const dir = tmpdir_();
		const src = join(dir, "long.ogg");
		genAudio(src, 25);
		let n = 0;
		const engine: SpeechEngine = {
			id: "test/fake-whisper",
			limits: { maxBytes: 25 * 1024 * 1024, maxSeconds: 15 * 60 },
			prep: { container: "keep" },
			transcribe: async () => {
				n += 1;
				if (n === 2) throw new Error("whisper dropped mid-stream");
				return { text: `chunk-${n}` };
			},
		};
		// Partial beats nothing — the boundary is logged and the prefix kept.
		expect(await transcribeAudio(engine, file(src), { maxBytes: 1, segmentSeconds: 10 })).toBe(
			"chunk-1",
		);
	});

	test("every segment silent → null", async () => {
		if (Bun.which("ffmpeg") === null) return; // environment dep
		const dir = tmpdir_();
		const src = join(dir, "long.ogg");
		genAudio(src, 5);
		const engine: SpeechEngine = {
			id: "whistle",
			limits: { maxSeconds: 28 },
			prep: { container: "wav", sampleRateHz: 16_000, mono: true },
			transcribe: async () => ({ text: "", language: "" }),
		};
		expect(await transcribeAudio(engine, file(src), { segmentSeconds: 10 })).toBeNull();
	});

	test("past the segment ceiling the transcription fails loud, not slow", async () => {
		if (Bun.which("ffmpeg") === null) return; // environment dep
		const dir = tmpdir_();
		const src = join(dir, "long.ogg");
		genAudio(src, 11);
		const engine: SpeechEngine = {
			id: "whistle",
			limits: { maxSeconds: 28 },
			prep: { container: "wav", sampleRateHz: 16_000, mono: true },
			transcribe: async () => ({ text: "x" }),
		};
		// 11 s at 40 ms segments → 275 segments > 240: the guard fires
		// before any engine call grinds through them.
		await expect(transcribeAudio(engine, file(src), { segmentSeconds: 0.04 })).rejects.toThrow(
			"275 segments (max 240)",
		);
	});

	test("a corrupt source fails loud through ffmpeg", async () => {
		if (Bun.which("ffmpeg") === null) return;
		const f = join(tmpdir_(), "junk.ogg");
		writeFileSync(f, "definitely not audio");
		await expect(transcribeAudio(keepEngine("x"), file(f), { maxBytes: 1 })).rejects.toThrow(
			"ffmpeg",
		);
	});

	test("a missing file fails loud", async () => {
		await expect(
			transcribeAudio(keepEngine("x"), file(join(tmpdir_(), "gone.ogg"))),
		).rejects.toThrow();
	});
});
