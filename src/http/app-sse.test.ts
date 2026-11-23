import { describe, expect, jest, test } from "bun:test";
import { appSseWriter } from "./app-sse.ts";

describe("app SSE writer", () => {
	test("writes a heartbeat while the stream is idle", async () => {
		jest.useFakeTimers();
		try {
			const writer = appSseWriter("app/heartbeat", 1);
			const reader = writer.body.getReader();
			jest.advanceTimersByTime(200);
			expect(new TextDecoder().decode((await reader.read()).value)).toBe(": ping\n\n");
			writer.dispose();
		} finally {
			jest.useRealTimers();
		}
	});

	test("writes chunks and finishes a live response", async () => {
		const writer = appSseWriter("app/live", 0);
		const reader = writer.body.getReader();
		writer.write({ type: "start", messageId: "a1" });
		writer.finish({ kind: "completed" });
		const chunks: string[] = [];
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			chunks.push(new TextDecoder().decode(result.value));
		}
		expect(chunks.join("")).toContain('"messageId":"a1"');
		expect(chunks.join("")).toContain("data: [DONE]");
		expect(writer.wireDied()).toBe(false);
	});

	test("does not duplicate an error chunk and closes a failed turn with an error finish", async () => {
		const writer = appSseWriter("app/failed", 0);
		const reader = writer.body.getReader();
		writer.write({ type: "start", messageId: "a1" });
		writer.write({ type: "error", errorText: "invalid request shape" });
		writer.finish({ kind: "error", message: "invalid request shape" });
		const body: string[] = [];
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			body.push(new TextDecoder().decode(result.value));
		}
		const records = body
			.join("")
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => line.slice("data: ".length));
		expect(records.map((record) => record === "[DONE]" ? record : JSON.parse(record))).toEqual([
			{ type: "start", messageId: "a1" },
			{ type: "error", errorText: "invalid request shape" },
			{ type: "finish", finishReason: "error" },
			"[DONE]",
		]);
	});

	test("a cancelled response records the wire as dead", async () => {
		const writer = appSseWriter("app/closed", 0);
		const reader = writer.body.getReader();
		await reader.cancel();
		reader.releaseLock();
		expect(writer.wireDied()).toBe(true);
		writer.finish({ kind: "completed" });
	});
});
