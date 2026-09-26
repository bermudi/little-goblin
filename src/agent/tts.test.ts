import { describe, expect, test } from "bun:test";
import {
	chunkSpeech,
	detectLanguage,
	pickVoice,
	speakable,
	speechContent,
	synthesizeSpeech,
	STATUS_TAIL_MARK,
} from "./tts.ts";

describe("tts", () => {
	test("chunks long input at sentence boundaries under the service guard", () => {
		const sentence = `${"word ".repeat(900)}done.`;
		const chunks = chunkSpeech(`${sentence} ${sentence} ${sentence}`, 10_000);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= 10_000)).toBe(true);
		expect(chunks.join(" ")).toBe(`${sentence} ${sentence} ${sentence}`);
	});

	test("button speech strips the status tail and markdown", () => {
		// Built with the shared marker — this test is the cross-file
		// contract: what delivery appends, speakable strips.
		expect(
			speakable(
				`## Hello **there**\n\nRead [the guide](https://example.com).${STATUS_TAIL_MARK}⚙ bash pwd`,
			),
		).toBe("Hello there\n\nRead the guide.");
	});

	test("voice mode keeps code blocks and long urls as supplemental text", () => {
		const url = `https://example.com/${"a".repeat(80)}`;
		const content = speechContent(`Start.\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n${url}\n\nDone.`);
		expect(content.spoken).toBe("Start.\n\nDone.");
		expect(content.supplemental).toContain("const x = 1;");
		expect(content.supplemental).toContain(url);
	});

	test("synthesizes every internal chunk as ogg/opus", async () => {
		const calls: Array<{ text: string; outputFormat: string; voice: string; lang: string }> = [];
		const synth = async (text: string, options: { voice: string; lang: string; outputFormat: string }) => {
			calls.push({ text, outputFormat: options.outputFormat, voice: options.voice, lang: options.lang });
			return new Uint8Array([26, 69, 223, 163]);
		};
		const audio = await synthesizeSpeech("One sentence. Two sentence.", {
			kind: "edge",
			voice: "en-US-AriaNeural",
			rate: "+10%",
		}, synth, 15, async () => new Uint8Array([79, 103, 103, 83]));
		expect(calls).toEqual([
			{ text: "One sentence.", outputFormat: "webm-24khz-16bit-mono-opus", voice: "en-US-AriaNeural", lang: "en-US" },
			{ text: "Two sentence.", outputFormat: "webm-24khz-16bit-mono-opus", voice: "en-US-AriaNeural", lang: "en-US" },
		]);
		expect(audio).toHaveLength(2);
		expect(new TextDecoder().decode(audio[0]!.slice(0, 4))).toBe("OggS");
	});

	test("an overridden voice carries its language into the SSML", async () => {
		// The speak tool swaps the whole config voice exactly like index.ts
		// does — the invariant this pins: a Spanish voice name must yield a
		// Spanish SSML lang.
		const config = { kind: "edge" as const, voice: "en-US-AriaNeural", voices: ["es-ES-ElviraNeural"] };
		const calls: Array<{ voice: string; lang: string }> = [];
		await synthesizeSpeech("Hola.", { ...config, voice: "es-ES-ElviraNeural" }, async (_text, options) => {
			calls.push({ voice: options.voice, lang: options.lang });
			return new Uint8Array([1]);
		}, 10_000, async () => new Uint8Array([79, 103, 103, 83]));
		expect(calls).toEqual([{ voice: "es-ES-ElviraNeural", lang: "es-ES" }]);
	});
});

describe("voice cast", () => {
	test("the reply's language casts its voice; the default speaks english", () => {
		expect(pickVoice("¿Listo para mañana? Sí, claro.", "en-US-AndrewNeural", ["es-MX-JorgeNeural"]))
			.toBe("es-MX-JorgeNeural");
		expect(
			pickVoice("Sure — done and working. Let me know if you need more.", "en-US-AndrewNeural", [
				"es-MX-JorgeNeural",
			]),
		).toBe("en-US-AndrewNeural");
	});

	test("short or ambiguous text falls back to the default voice", () => {
		// One spanish signal each — under the decision bar.
		expect(pickVoice("Listo.", "en-US-AndrewNeural", ["es-MX-JorgeNeural"])).toBe(
			"en-US-AndrewNeural",
		);
		expect(pickVoice("OK, done.", "en-US-AndrewNeural", ["es-MX-JorgeNeural"])).toBe(
			"en-US-AndrewNeural",
		);
		expect(pickVoice("42 + 58 = 100", "en-US-AndrewNeural", ["es-MX-JorgeNeural"])).toBe(
			"en-US-AndrewNeural",
		);
	});

	test("unaccented spanish still sniffs via function words", () => {
		expect(detectLanguage("Listo, gracias. El cambio esta hecho")).toBe("es");
		expect(detectLanguage("Sure, the work is done and the build is green")).toBe("en");
	});

	test("without a cast, the default voice speaks everything", () => {
		expect(pickVoice("Hola, ¿qué tal?", "en-US-AndrewNeural", undefined)).toBe(
			"en-US-AndrewNeural",
		);
	});

	test("synthesis auto-matches a configured cast", async () => {
		const calls: Array<{ voice: string; lang: string }> = [];
		await synthesizeSpeech(
			"¿Listo para mañana? Sí, claro.",
			{ kind: "edge", voice: "en-US-AndrewNeural", voices: ["es-MX-JorgeNeural"] },
			async (_text, options) => {
				calls.push({ voice: options.voice, lang: options.lang });
				return new Uint8Array([1]);
			},
			10_000,
			async () => new Uint8Array([79, 103, 103, 83]),
		);
		expect(calls).toEqual([{ voice: "es-MX-JorgeNeural", lang: "es-MX" }]);
	});
});
