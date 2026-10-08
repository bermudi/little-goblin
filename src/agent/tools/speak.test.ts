import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTools } from "./mod.ts";
import { speakInputSchema, speakTool } from "./speak.ts";

const dirs: string[] = [];
const opts = { toolCallId: "t1", messages: [], context: {} };

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

describe("speak", () => {
	test("is absent when tts is not configured", () => {
		expect(makeTools("/tmp").speak).toBeUndefined();
	});

	test("synthesizes a text file directly and delivers every chunk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-speak-"));
		dirs.push(dir);
		writeFileSync(join(dir, "note.md"), "Read this from disk.");
		const inputs: string[] = [];
		const delivered: number[] = [];
		const t = speakTool(
			dir,
			async (text) => {
				inputs.push(text);
				return [new Uint8Array([1]), new Uint8Array([2])];
			},
			async (audio) => {
				delivered.push(audio[0]!);
			},
		);
		const out = await t.execute!({ path: "note.md" }, opts);
		expect(inputs).toEqual(["Read this from disk."]);
		expect(delivered).toEqual([1, 2]);
		expect(out).toEqual({ sent: 2 });
	});

	test("surfaces synthesis failure as a tool result", async () => {
		const t = speakTool(
			"/tmp",
			async () => {
				throw new Error("edge is down");
			},
			async () => {},
		);
		const out = (await t.execute!({ text: "hello" }, opts)) as { error?: string };
		expect(out.error).toContain("edge is down");
	});
});

describe("speak input rule", () => {
	test("input is exactly one of text or path", () => {
		expect(speakInputSchema().safeParse({ text: "hi" }).success).toBe(true);
		expect(speakInputSchema().safeParse({ path: "note.md" }).success).toBe(true);
		expect(speakInputSchema().safeParse({ text: "hi", path: "note.md" }).success).toBe(false);
		expect(speakInputSchema().safeParse({}).success).toBe(false);
	});
});

describe("speak voice choice", () => {
	const allow = ["en-US-AriaNeural", "es-ES-ElviraNeural"];

	test("threads a chosen voice to synthesize", async () => {
		const calls: Array<{ text: string; voice?: string | undefined }> = [];
		const t = speakTool(
			"/tmp",
			async (text, voice) => {
				calls.push({ text, voice });
				return [new Uint8Array([1])];
			},
			async () => {},
			undefined,
			allow,
		);
		const out = await t.execute!({ text: "hola", voice: "es-ES-ElviraNeural" }, opts);
		expect(out).toEqual({ sent: 1 });
		expect(calls).toEqual([{ text: "hola", voice: "es-ES-ElviraNeural" }]);
	});

	test("omitting the voice threads undefined — default synthesis", async () => {
		const calls: Array<{ text: string; voice?: string | undefined }> = [];
		const t = speakTool(
			"/tmp",
			async (text, voice) => {
				calls.push({ text, voice });
				return [new Uint8Array([1])];
			},
			async () => {},
			undefined,
			allow,
		);
		await t.execute!({ text: "hi" }, opts);
		expect(calls).toEqual([{ text: "hi", voice: undefined }]);
	});

	test("a voice outside the allowlist fails schema validation", () => {
		const parsed = speakInputSchema(allow).safeParse({ text: "hola", voice: "es-MX-DaliaNeural" });
		expect(parsed.success).toBe(false);
	});

	test("a voice without configured alternates fails schema validation", () => {
		expect(speakInputSchema().safeParse({ text: "hi", voice: "es-ES-ElviraNeural" }).success).toBe(
			false,
		);
	});

	test("the description offers the configured voices, and stays bare without them", () => {
		const withVoices = speakTool(
			"/tmp",
			async () => [],
			async () => {},
			undefined,
			allow,
		);
		expect(withVoices.description).toContain("es-ES-ElviraNeural");
		const bare = speakTool(
			"/tmp",
			async () => [],
			async () => {},
		);
		expect(bare.description).toBe(
			"Synthesize text or a plain-text/Markdown file and send it as Telegram voice notes.",
		);
	});
});

describe("speak recording indicator", () => {
	test("record_voice brackets synthesis — started before, stopped after delivery", async () => {
		const events: string[] = [];
		const t = speakTool(
			"/tmp",
			async () => {
				events.push("synthesize");
				return [new Uint8Array([1])];
			},
			async () => {
				events.push("deliver");
			},
			() => {
				events.push("recording-start");
				return () => events.push("recording-stop");
			},
		);
		await t.execute!({ text: "hello" }, opts);
		expect(events).toEqual(["recording-start", "synthesize", "deliver", "recording-stop"]);
	});

	test("a failed synthesis still stops the indicator", async () => {
		const events: string[] = [];
		const t = speakTool(
			"/tmp",
			async () => {
				throw new Error("edge is down");
			},
			async () => {},
			() => {
				events.push("recording-start");
				return () => events.push("recording-stop");
			},
		);
		const out = (await t.execute!({ text: "x" }, opts)) as { error?: string };
		expect(out.error).toContain("edge is down");
		expect(events).toEqual(["recording-start", "recording-stop"]);
	});
});
