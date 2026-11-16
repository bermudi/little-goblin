import { beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isStepCount, streamText } from "ai";
import { setLogFile } from "../../log.ts";
import { deferred, tmpDir } from "../../testkit.ts";
import { finishPart, scriptedModel, textParts, toolCallPart } from "../../testkit/fake-model.ts";
import { CHUNK_CHARS, readLongTool, splitText } from "./read-long.ts";

const opts = { toolCallId: "t1", messages: [], context: {} };

beforeAll(() => {
	setLogFile(null);
});

describe("read_long", () => {
	test("calls from one step run in parallel and both answers reach the turn", async () => {
		const dir = tmpDir("goblin-read-long-");
		writeFileSync(join(dir, "a.txt"), "Alpha report. Revenue was 12.");
		writeFileSync(join(dir, "b.txt"), "Beta report. Revenue was 34.");
		let inFlight = 0;
		let peak = 0;
		const bothStarted = deferred();
		const tool = readLongTool(dir, {
			conversation: "c1",
			complete: async (_system, prompt) => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				if (inFlight === 2) bothStarted.resolve();
				// Neither helper finishes until both are running.
				await bothStarted.promise;
				inFlight--;
				return prompt.includes("Alpha") ? "alpha: 12" : "beta: 34";
			},
		});
		const model = scriptedModel([
			[
				{ type: "stream-start", warnings: [] },
				toolCallPart("c-a", "read_long", JSON.stringify({ path: "a.txt", question: "revenue?" })),
				toolCallPart("c-b", "read_long", JSON.stringify({ path: "b.txt", question: "revenue?" })),
				finishPart("tool-calls"),
			],
			textParts("done"),
		]);
		const result = streamText({
			model: model.model,
			prompt: "read both",
			tools: { read_long: tool },
			stopWhen: isStepCount(2),
		});
		const text = await result.text;
		expect(text).toBe("done");
		expect(peak).toBe(2);
		const outputs = JSON.stringify((await result.steps)[0]!.toolResults.map((r) => r.output));
		expect(outputs).toContain("alpha: 12");
		expect(outputs).toContain("beta: 34");
	});

	test("a file over one helper's size is split, one labelled answer per part", async () => {
		const dir = tmpDir("goblin-read-long-");
		const para = `${"word ".repeat(1000)}\n\n`;
		const body = para.repeat(Math.ceil((CHUNK_CHARS * 2.5) / para.length));
		writeFileSync(join(dir, "big.txt"), body);
		const prompts: string[] = [];
		const tool = readLongTool(dir, {
			conversation: "c1",
			complete: async (_system, prompt) => {
				prompts.push(prompt);
				return `seen ${prompts.length}`;
			},
		});
		const out = await tool.execute!(
			{ path: "big.txt", question: "themes?" },
			{ ...opts, abortSignal: new AbortController().signal },
		);
		expect(out).toMatchObject({ parts: 3 });
		expect(prompts).toHaveLength(3);
		expect(prompts.some((p) => p.includes("part 3 of 3"))).toBe(true);
		const answer = (out as { answer: string }).answer;
		expect(answer).toContain("## Part 1 of 3");
		expect(answer).toContain("## Part 3 of 3");
		// Splits land on paragraph breaks and lose nothing.
		expect(splitText(body, CHUNK_CHARS).join("")).toBe(body);
	});

	test("a binary file is refused before any model call", async () => {
		const dir = tmpDir("goblin-read-long-");
		writeFileSync(join(dir, "doc.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]));
		let called = false;
		const tool = readLongTool(dir, {
			conversation: "c1",
			complete: async () => {
				called = true;
				return "";
			},
		});
		const out = await tool.execute!({ path: "doc.pdf", question: "what?" }, opts);
		expect(out).toMatchObject({ error: expect.stringContaining("not a text file") });
		expect(called).toBe(false);
	});
});
