import { describe, expect, test } from "bun:test";
import {
	chunkSpeech,
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
		const calls: Array<{ text: string; outputFormat: string }> = [];
		const audio = await synthesizeSpeech("One sentence. Two sentence.", {
			kind: "edge",
			voice: "en-US-AriaNeural",
			rate: "+10%",
		}, async (text, options) => {
			calls.push({ text, outputFormat: options.outputFormat });
			return new Uint8Array([26, 69, 223, 163]);
		}, 15, async () => new Uint8Array([79, 103, 103, 83]));
		expect(calls).toEqual([
			{ text: "One sentence.", outputFormat: "webm-24khz-16bit-mono-opus" },
			{ text: "Two sentence.", outputFormat: "webm-24khz-16bit-mono-opus" },
		]);
		expect(audio).toHaveLength(2);
		expect(new TextDecoder().decode(audio[0]!.slice(0, 4))).toBe("OggS");
	});
});
