import { describe, expect, test } from "bun:test";
import { screenMemoryText } from "./memory-screen.ts";

describe("memory credential screening", () => {
	test("recognizes synthetic tokens and stays idempotent", () => {
		const token = `sk-proj-${"x".repeat(40)}`;
		const input = `Operator: api_key="${token}"\nGoblin: Bearer ${token}`;
		const result = screenMemoryText(input, "test");
		expect(result).not.toContain(token);
		expect(result).toContain("[REDACTED:");
		expect(screenMemoryText(result, "test")).toBe(result);
		expect(input).toContain(token);
	});

	test("screens assignments, quoted JSON, authorization, URLs and private keys", () => {
		const opaque = "synthetic-only-value";
		for (const input of [
			`password=${opaque}`,
			`{"client_secret":"${opaque}"}`,
			`ACCESS_TOKEN = '${opaque}'`,
			`Authorization: Bearer ${opaque}`,
			`postgresql://test:${opaque}@db/test`,
			`-----BEGIN PRIVATE KEY-----\n${opaque}\n-----END PRIVATE KEY-----`,
		]) {
			const result = screenMemoryText(input, "test");
			expect(result).not.toContain(opaque);
			expect(screenMemoryText(result, "test")).toBe(result);
		}
	});

	test("does not alter ordinary facts, dates, paths or source identifiers", () => {
		const ordinary =
			"Operator: Prefer quiet mornings. Decision: ship at 08:00.\nSource: exchange/dm:1/42/a. The secret garden is a book.";
		expect(screenMemoryText(ordinary, "test")).toBe(ordinary);
	});

	test("a redaction marker embedded in a credential is not a bypass", () => {
		const result = screenMemoryText('password="[REDACTED:test] plus-sensitive-content"', "test");
		expect(result).not.toContain("plus-sensitive-content");
	});

	test("handles escaped quoted values and bounded large prose", () => {
		const result = screenMemoryText('{"password":"synthetic\\\"quoted\\\\value"}', "test");
		expect(result).not.toContain("synthetic");
		expect(screenMemoryText("word ".repeat(200_000), "test")).toHaveLength(1_000_000);
	});
});
