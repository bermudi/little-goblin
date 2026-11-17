import { beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isStepCount, streamText } from "ai";
import { setLogFile } from "../../log.ts";
import { deferred, tmpDir } from "../../testkit.ts";
import { finishPart, scriptedModel, textParts, toolCallPart } from "../../testkit/fake-model.ts";
import { toToolSet } from "../../turn/ai-sdk-tools.ts";
import { CHUNK_CHARS, MAX_PARTS, readLongTool, splitText } from "./read-long.ts";

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
			tools: toToolSet({ read_long: tool }),
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

	test("a file past the part cap is refused before any model call", async () => {
		const dir = tmpDir("goblin-read-long-");
		writeFileSync(join(dir, "cap.txt"), "x".repeat(CHUNK_CHARS * MAX_PARTS));
		writeFileSync(join(dir, "over.txt"), "x".repeat(CHUNK_CHARS * MAX_PARTS + 1));
		let called = 0;
		const tool = readLongTool(dir, {
			conversation: "c1",
			complete: async () => {
				called++;
				return "ok";
			},
		});
		const over = await tool.execute!({ path: "over.txt", question: "what?" }, opts);
		expect(over).toMatchObject({ error: expect.stringContaining(`max ${MAX_PARTS}`) });
		expect(called).toBe(0);
		const cap = await tool.execute!({ path: "cap.txt", question: "what?" }, opts);
		expect(cap).toMatchObject({ parts: MAX_PARTS });
		expect(called).toBe(MAX_PARTS);
	});

	test("non-text files are refused before any model call", async () => {
		const dir = tmpDir("goblin-read-long-");
		writeFileSync(join(dir, "bad-utf8.bin"), Buffer.from([0x66, 0xff, 0xfe, 0xfd, 0x80]));
		writeFileSync(join(dir, "nul.bin"), Buffer.from([0x41, 0x00, 0x42]));
		writeFileSync(join(dir, "unicode.txt"), "\uFEFFcafé — 数据 🚀");
		let called = 0;
		const tool = readLongTool(dir, {
			conversation: "c1",
			complete: async () => {
				called++;
				return "";
			},
		});
		for (const path of ["bad-utf8.bin", "nul.bin"]) {
			const out = await tool.execute!({ path, question: "what?" }, opts);
			expect(out).toMatchObject({ error: expect.stringContaining("not a UTF-8 text file") });
		}
		expect(called).toBe(0);
		const out = await tool.execute!({ path: "unicode.txt", question: "what?" }, opts);
		expect(out).not.toHaveProperty("error");
		expect(called).toBe(1);
	});

	test("a failed part stops dispatch and the tool returns only after in-flight parts settle", async () => {
		const dir = tmpDir("goblin-read-long-");
		// Eight parts; four start at once.
		writeFileSync(join(dir, "big.txt"), "x".repeat(CHUNK_CHARS * 8));
		const started: number[] = [];
		let settled = 0;
		let abortedInFlight = 0;
		const tool = readLongTool(dir, {
			conversation: "c1",
			complete: async (_system, prompt, signal) => {
				const part = Number(/part (\d+) of/.exec(prompt)![1]);
				started.push(part);
				try {
					if (part === 1) throw new Error("SYNTHETIC_PART_ONE_FAILURE");
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(resolve, 5_000);
						signal.addEventListener("abort", () => {
							clearTimeout(timer);
							abortedInFlight++;
							reject(signal.reason);
						});
					});
					return "late";
				} finally {
					settled++;
				}
			},
		});
		const out = await tool.execute!(
			{ path: "big.txt", question: "what?" },
			{ ...opts, abortSignal: new AbortController().signal },
		);
		expect(out).toMatchObject({ error: expect.stringContaining("SYNTHETIC_PART_ONE_FAILURE") });
		expect(started.sort()).toEqual([1, 2, 3, 4]);
		expect(abortedInFlight).toBe(3);
		expect(settled).toBe(4);
		// Nothing dispatches after the tool returned.
		await new Promise((r) => setTimeout(r, 50));
		expect(started).toHaveLength(4);
	});
});
