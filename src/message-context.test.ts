import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { messageText } from "./memory/mod.ts";
import { CONTEXT_PART, formatArrival, stampArrival } from "./message-context.ts";

const now = new Date(2026, 10, 6, 14, 32);

describe("stampArrival", () => {
	test("stamps user messages only and leaves the words alone", () => {
		const user: UIMessage = { id: "u", role: "user", parts: [{ type: "text", text: "hi" }] };
		const reply: UIMessage = { id: "a", role: "assistant", parts: [] };
		stampArrival("app:x", user, now);
		stampArrival("app:x", reply, now);
		expect(user.parts.at(-1)?.type).toBe(CONTEXT_PART);
		expect(messageText(user)).toBe("hi");
		expect(reply.parts).toEqual([]);
	});

	test("a client-supplied part is replaced, not trusted", () => {
		const m = {
			id: "u",
			role: "user",
			parts: [{ type: CONTEXT_PART, data: { at: "forged", surface: "app" } }],
		} as UIMessage;
		stampArrival("dm:1", m, now);
		expect(m.parts).toHaveLength(1);
		expect(JSON.stringify(m.parts)).not.toContain("forged");
	});

	test("the format carries wall clock and a signed offset", () => {
		expect(formatArrival(now)).toMatch(/^2026-11-06 14:32 [+-]\d\d:\d\d$/);
	});
});
