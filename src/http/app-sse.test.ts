import { describe, expect, test } from "bun:test";
import { appSseWriter } from "./app-sse.ts";

describe("app SSE writer", () => {
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

	test("a cancelled response records the wire as dead", async () => {
		const writer = appSseWriter("app/closed", 0);
		const reader = writer.body.getReader();
		await reader.cancel();
		reader.releaseLock();
		expect(writer.wireDied()).toBe(true);
		writer.finish({ kind: "completed" });
	});
});
