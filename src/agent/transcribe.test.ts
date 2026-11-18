import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	transcribeAudio,
	transcribeChain,
	transcribeSegmented,
	type EngineTranscript,
	type SpeechEngine,
} from "./transcribe.ts";
import { tmpDir } from "../testkit.ts";

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

function genLongLowBitrateAudio(dest: string, seconds: number): void {
	// Stretch packet timestamps instead of encoding hours of silence; the
	// resulting small Opus file has the same long duration ffprobe sees.
	const gen = Bun.spawnSync([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=2",
		"-af",
		`asetpts=PTS*${Math.ceil(seconds / 2) + 200}`,
		"-c:a",
		"libopus",
		"-b:a",
		"4k",
		dest,
	]);
	if (gen.exitCode !== 0) throw new Error(`long test audio gen: ${gen.stderr.toString()}`);
}

function genUnknownDurationAudio(dest: string): void {
	const gen = Bun.spawnSync([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=5",
		"-c:a",
		"libopus",
		"-f",
		"webm",
		"pipe:1",
	]);
	if (gen.exitCode !== 0) throw new Error(`unknown-duration audio gen: ${gen.stderr.toString()}`);
	writeFileSync(dest, gen.stdout);
}

// MediaRecorder pathology: pts ×400 at encode makes a 9 s note claim
// ~3600 s of packet time — without the orchestrator's sample-count pts
// rebuild the muxer cuts per packet (the production 9 s webm made 153).
function genBrokenAudio(dest: string, seconds: number): void {
	const gen = Bun.spawnSync([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:duration=${seconds}`,
		"-af",
		"asetpts=PTS*400",
		"-c:a",
		"libopus",
		dest,
	]);
	if (gen.exitCode !== 0) throw new Error(`broken audio gen: ${gen.stderr.toString()}`);
}

// Ogg codec magic: opus "OpusHead", vorbis "\u0001vorbis",
// FLAC-in-Ogg "\u007fFLAC".
function oggCodec(audio: Uint8Array): string {
	const head = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
		.toString("latin1")
		.slice(0, 128);
	if (head.includes("OpusHead")) return "opus";
	if (head.includes("vorbis")) return "vorbis";
	if (head.includes("FLAC")) return "flac";
	return "unknown";
}

// RIFF fmt chunk: channels at byte offset 22, sample rate at 24.
function wavShape(audio: Uint8Array): { channels: number; sampleRate: number } {
	const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
	return { channels: view.getUint16(22, true), sampleRate: view.getUint32(24, true) };
}

describe("transcribeAudio", () => {
	test("returns the trimmed transcript", async () => {
		const dir = tmpDir("goblin-tr-");
		const f = join(dir, "v.ogg");
		genAudio(f, 1);
		expect(await transcribeAudio(keepEngine("  call me back  "), file(f))).toBe("call me back");
	});

	test("silence (empty transcript) → null", async () => {
		const dir = tmpDir("goblin-tr-");
		const f = join(dir, "v.ogg");
		genAudio(f, 1);
		expect(await transcribeAudio(keepEngine("   "), file(f))).toBeNull();
	});

	test("small-bytes audio over the time bound rejects before an engine call", async () => {
		const dir = tmpDir("goblin-tr-");
		const src = join(dir, "long-low-bitrate.ogg");
		genLongLowBitrateAudio(src, 240 * 28 + 1);
		expect(statSync(src).size).toBeLessThan(25 * 1024 * 1024);
		let calls = 0;
		const engine: SpeechEngine = {
			id: "test/cloud",
			limits: { maxBytes: 25 * 1024 * 1024, maxSeconds: 15 * 60 },
			prep: { container: "keep" },
			transcribe: async () => {
				calls += 1;
				return { text: "unexpected" };
			},
		};
		await expect(transcribeAudio(engine, file(src))).rejects.toThrow(
			/audio is .+ \(\d+ s\); one transcribe call takes at most 1 h 52 m \(6720 s\) — cut it first, e.g. ffmpeg -ss <start> -t <seconds> -c copy/,
		);
		expect(calls).toBe(0);
	}, 30_000);

	test("a short keep-profile file under maxBytes uses one engine call", async () => {
		const src = join(tmpDir("goblin-tr-"), "short.ogg");
		genAudio(src, 2);
		let calls = 0;
		const engine: SpeechEngine = {
			id: "test/cloud",
			limits: { maxBytes: 25 * 1024 * 1024, maxSeconds: 15 * 60 },
			prep: { container: "keep" },
			transcribe: async () => {
				calls += 1;
				return { text: "short transcript" };
			},
		};
		expect(await transcribeAudio(engine, file(src))).toBe("short transcript");
		expect(calls).toBe(1);
	});

	test("unknown duration falls back to bounded segmentation", async () => {
		const src = join(tmpDir("goblin-tr-"), "unbounded.webm");
		genUnknownDurationAudio(src);
		let calls = 0;
		let uploadedPath = "";
		const engine: SpeechEngine = {
			id: "test/cloud",
			limits: { maxBytes: 25 * 1024 * 1024, maxSeconds: 15 * 60 },
			prep: { container: "keep" },
			transcribe: async (uploaded) => {
				calls += 1;
				uploadedPath = uploaded.path;
				return { text: "segmented transcript" };
			},
		};
		expect(
			await transcribeAudio(engine, { ...file(src), mediaType: "audio/webm" }, {
				segmentSeconds: 10,
			}),
		).toBe("segmented transcript");
		expect(calls).toBe(1);
		expect(uploadedPath).not.toBe(src);
		expect(uploadedPath.endsWith(".ogg")).toBe(true);
	});

	test("missing ffprobe rejects keep-profile audio before an engine call", async () => {
		const src = join(tmpDir("goblin-tr-"), "short.ogg");
		genAudio(src, 2);
		let calls = 0;
		const engine: SpeechEngine = {
			id: "test/cloud",
			limits: { maxBytes: 25 * 1024 * 1024, maxSeconds: 15 * 60 },
			prep: { container: "keep" },
			transcribe: async () => {
				calls += 1;
				return { text: "unexpected" };
			},
		};
		const oldPath = process.env.PATH;
		process.env.PATH = tmpDir("goblin-no-tools-");
		try {
			await expect(transcribeAudio(engine, file(src))).rejects.toThrow(
				"ffprobe is required to bound audio time before upload:",
			);
			expect(calls).toBe(0);
		} finally {
			if (oldPath === undefined) delete process.env.PATH;
			else process.env.PATH = oldPath;
		}
	});

	test("over-cap media is segmented to mono opus and joined", async () => {
		if (Bun.which("ffmpeg") === null) return; // environment dep
		const dir = tmpDir("goblin-tr-");
		const src = join(dir, "long.ogg");
		// A 1-byte cap forces the segment path without a real 25 MiB
		// fixture.
		genAudio(src, 25);
		const seen: { path: string; bytes: Uint8Array }[] = [];
		let n = 0;
		const engine: SpeechEngine = {
			id: "test/fake-whisper",
			limits: { maxBytes: 25 * 1024 * 1024, maxSeconds: 15 * 60 },
			prep: { container: "keep" },
			// Without -c:a the Ogg segment muxer picks the build's default
			// encoder — libvorbis or FLAC — which ignores -b:a and can
			// re-exceed the 25 MiB upload cap. Sniffing what the engine
			// would upload pins that at the boundary.
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
	}, 30_000);

	test("keep-profile cloud audio over the duration bound fails before transcription", async () => {
		let calls = 0;
		const engine: SpeechEngine = {
			id: "test/cloud",
			limits: { maxSeconds: 15 * 60 },
			prep: { container: "keep" },
			transcribe: async () => {
				calls += 1;
				return { text: "unexpected" };
			},
		};
		await expect(
			transcribeSegmented(engine, file("source.ogg"), 15 * 60, async () =>
				Array.from({ length: 8 }, (_, i) => `segment-${i}.ogg`),
			),
		).rejects.toThrow(
			"audio needs 8 segments of 15 m; one transcribe call takes at most 7 (1 h 45 m)",
		);
		expect(calls).toBe(0);
	});

	test("keep-profile cloud audio within the duration bound transcribes", async () => {
		let calls = 0;
		const engine: SpeechEngine = {
			id: "test/cloud",
			limits: { maxSeconds: 15 * 60 },
			prep: { container: "keep" },
			transcribe: async () => {
				calls += 1;
				return { text: "chunk" };
			},
		};
		expect(
			await transcribeSegmented(engine, file("source.ogg"), 15 * 60, async () =>
				Array.from({ length: 7 }, (_, i) => `segment-${i}.ogg`),
			),
		).toBe("chunk chunk chunk chunk chunk chunk chunk");
		expect(calls).toBe(7);
	});

	test("the wav profile always segments to 16 kHz mono pcm and joins", async () => {
		if (Bun.which("ffmpeg") === null) return; // environment dep
		const dir = tmpDir("goblin-tr-");
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
	}, 30_000);

	test("broken container timestamps still segment by wall time", async () => {
		if (Bun.which("ffmpeg") === null) return; // environment dep
		const dir = tmpDir("goblin-tr-");
		const src = join(dir, "note.webm");
		genBrokenAudio(src, 9);
		let n = 0;
		const engine: SpeechEngine = {
			id: "whistle",
			limits: { maxSeconds: 28 },
			prep: { container: "wav", sampleRateHz: 16_000, mono: true },
			transcribe: async () => {
				n += 1;
				return { text: "nine seconds" };
			},
		};
		// Unrepaired pts would cut ~129 segments; rebuilt pts → one 9 s
		// file under the 28 s ceiling → a single segment, a single call.
		expect(await transcribeAudio(engine, file(src), { segmentSeconds: 28 })).toBe("nine seconds");
		expect(n).toBe(1);
	});

	test("an over-cap outage with nothing transcribed fails loud, never reads as no-speech", async () => {
		if (Bun.which("ffmpeg") === null) return; // environment dep
		const dir = tmpDir("goblin-tr-");
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
		// null would ride the tool's "may contain no speech" string —
		// the provider error must reach the caller.
		await expect(transcribeAudio(engine, file(src), { maxBytes: 1 })).rejects.toThrow(
			"whisper is down",
		);
	});

	test("a failed segment removes its scratch directory", async () => {
		if (Bun.which("ffmpeg") === null) return;
		const inputDir = tmpDir("goblin-tr-input-");
		const src = join(inputDir, "long.ogg");
		genAudio(src, 5);
		const before = readdirSync(tmpdir()).filter((name) => name.startsWith("goblin-tr-")).length;
		const engine: SpeechEngine = {
			id: "test/failing",
			limits: { maxBytes: 25 * 1024 * 1024, maxSeconds: 15 * 60 },
			prep: { container: "keep" },
			transcribe: async () => {
				throw new Error("segment failed");
			},
		};
		await expect(transcribeAudio(engine, file(src), { maxBytes: 1 })).rejects.toThrow(
			"segment failed",
		);
		expect(readdirSync(tmpdir()).filter((name) => name.startsWith("goblin-tr-")).length).toBe(
			before,
		);
	});

	test("an over-cap outage mid-stream keeps the segments before it", async () => {
		if (Bun.which("ffmpeg") === null) return; // environment dep
		const dir = tmpDir("goblin-tr-");
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
		// Partial beats nothing.
		expect(await transcribeAudio(engine, file(src), { maxBytes: 1, segmentSeconds: 10 })).toBe(
			"chunk-1",
		);
	}, 30_000);

	test("every segment silent → null", async () => {
		if (Bun.which("ffmpeg") === null) return; // environment dep
		const dir = tmpDir("goblin-tr-");
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

	test("wav profile allows 240 28-second segments and rejects 241", async () => {
		let allowedCalls = 0;
		const engine: SpeechEngine = {
			id: "whistle",
			limits: { maxSeconds: 28 },
			prep: { container: "wav", sampleRateHz: 16_000, mono: true },
			transcribe: async () => {
				allowedCalls += 1;
				return { text: "ok" };
			},
		};
		const atBound = await transcribeSegmented(
			engine,
			file("source.wav"),
			28,
			async () => Array.from({ length: 240 }, (_, i) => `segment-${i}.wav`),
		);
		expect(atBound).toBe("ok ".repeat(239) + "ok");
		expect(allowedCalls).toBe(240);

		let rejectedCalls = 0;
		const rejectingEngine: SpeechEngine = {
			...engine,
			transcribe: async () => {
				rejectedCalls += 1;
				return { text: "unexpected" };
			},
		};
		await expect(
			transcribeSegmented(
				rejectingEngine,
				file("source.wav"),
				28,
				async () => Array.from({ length: 241 }, (_, i) => `segment-${i}.wav`),
			),
		).rejects.toThrow(
			"audio needs 241 segments of 28 s; one transcribe call takes at most 240 (1 h 52 m)",
		);
		expect(rejectedCalls).toBe(0);
	});

	test("an unparseable source fails loud through ffprobe before engine call", async () => {
		if (Bun.which("ffmpeg") === null) return;
		const f = join(tmpDir("goblin-tr-"), "junk.ogg");
		writeFileSync(f, "definitely not audio");
		let calls = 0;
		const engine: SpeechEngine = {
			...keepEngine("x"),
			transcribe: async () => {
				calls += 1;
				return { text: "unexpected" };
			},
		};
		await expect(transcribeAudio(engine, file(f), { maxBytes: 1 })).rejects.toThrow(
			"ffprobe is required to bound audio time before upload:",
		);
		expect(calls).toBe(0);
	});

	test("a missing file fails loud", async () => {
		await expect(
			transcribeAudio(keepEngine("x"), file(join(tmpDir("goblin-tr-"), "gone.ogg"))),
		).rejects.toThrow();
	});
});

describe("transcribeChain", () => {
	// Distinct ids — the chain's log line and combined error key on them.
	const idEngine = (
		id: string,
		run: (f: { path: string }) => Promise<EngineTranscript>,
	): SpeechEngine => ({
		id,
		limits: { maxBytes: 25 * 1024 * 1024, maxSeconds: 15 * 60 },
		prep: { container: "keep" },
		transcribe: run,
	});

	test("primary success never invokes the fallback", async () => {
		const dir = tmpDir("goblin-tr-");
		const f = join(dir, "v.ogg");
		genAudio(f, 1);
		let fallbackCalls = 0;
		const result = await transcribeChain(
			[
				idEngine("groq/x", async () => ({ text: "primary answer" })),
				idEngine("whistle", async () => {
					fallbackCalls += 1;
					return { text: "fallback answer" };
				}),
			],
			file(f),
		);
		expect(result).toBe("primary answer");
		expect(fallbackCalls).toBe(0);
	});

	test("a thrown primary advances to the fallback's transcript", async () => {
		const dir = tmpDir("goblin-tr-");
		const f = join(dir, "v.ogg");
		genAudio(f, 1);
		const result = await transcribeChain(
			[
				idEngine("groq/x", () => Promise.reject(new Error("HTTP 413"))),
				idEngine("whistle", async () => ({ text: "rescued" })),
			],
			file(f),
		);
		expect(result).toBe("rescued");
	});

	test("no-speech null is an answer, not a retry trigger", async () => {
		const dir = tmpDir("goblin-tr-");
		const f = join(dir, "v.ogg");
		genAudio(f, 1);
		let fallbackCalls = 0;
		const result = await transcribeChain(
			[
				idEngine("groq/x", async () => ({ text: "   " })),
				idEngine("whistle", async () => {
					fallbackCalls += 1;
					return { text: "hallucinated speech" };
				}),
			],
			file(f),
		);
		// A second engine disagreeing would manufacture speech — the
		// primary's null is definitive.
		expect(result).toBeNull();
		expect(fallbackCalls).toBe(0);
	});

	test("a fully failed chain throws one error naming each engine", async () => {
		const dir = tmpDir("goblin-tr-");
		const f = join(dir, "v.ogg");
		genAudio(f, 1);
		await expect(
			transcribeChain(
				[
					idEngine("groq/x", () => Promise.reject(new Error("HTTP 413"))),
					idEngine("whistle", () => Promise.reject(new Error("engine binary missing"))),
				],
				file(f),
			),
		).rejects.toThrow("groq/x: HTTP 413 | whistle: engine binary missing");
	});

	test("a lone engine throws verbatim — no chain decoration", async () => {
		const dir = tmpDir("goblin-tr-");
		const f = join(dir, "v.ogg");
		genAudio(f, 1);
		await expect(
			transcribeChain([idEngine("groq/x", () => Promise.reject(new Error("HTTP 413")))], file(f)),
		).rejects.toThrow("HTTP 413");
	});

	test("no engines configured answers null", async () => {
		const f = join(tmpDir("goblin-tr-"), "v.ogg");
		expect(await transcribeChain([], file(f))).toBeNull();
	});
});
