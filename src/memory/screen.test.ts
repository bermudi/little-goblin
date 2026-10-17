import { afterEach, describe, expect, test } from "bun:test";
import { screenMemoryText } from "./screen.ts";
import { setLogFile, setLogLevel, setLogWriter } from "../log.ts";

afterEach(() => {
	setLogFile(null);
	setLogWriter(null);
});

describe("memory credential screening", () => {
	test("recognizes canonical key assignments without a provider token prefix", () => {
		const value = "synthetic-opaque-key-material";
		for (const name of [
			"AWS_SECRET_ACCESS_KEY",
			"SECRET_ACCESS_KEY",
			"PRIVATE_KEY",
			"SIGNING_KEY",
			"ENCRYPTION_KEY",
			"SERVICE_API_KEY",
		]) {
			for (const input of [`${name}=${value}`, `{"${name}":"${value}"}`]) {
				const result = screenMemoryText(input, "test");
				expect(result).not.toContain(value);
				expect(screenMemoryText(result, "test")).toBe(result);
			}
		}
	});

	test("already-screened URL credentials produce no new screening events", () => {
		const lines: string[] = [];
		setLogLevel("info");
		setLogFile("synthetic-sink");
		setLogWriter((_path, line) => {
			lines.push(line);
		});
		const result = screenMemoryText("postgresql://user:synthetic-opaque-value@db", "test");
		expect(screenMemoryText(result, "test")).toBe(result);
		expect(screenMemoryText(result, "test")).toBe(result);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('"url_credentials":1');
		expect(lines[0]).not.toContain("synthetic-opaque-value");
	});

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
