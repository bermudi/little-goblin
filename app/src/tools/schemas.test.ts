import { describe, expect, test } from "bun:test";
import {
	bashInputSchema,
	bashOutputSchema,
	editInputSchema,
	editOutputSchema,
	fetchInputSchema,
	fetchOutputSchema,
	readInputSchema,
	readOutputSchema,
	searchInputSchema,
	searchOutputSchema,
	writeInputSchema,
	writeOutputSchema,
} from "./schemas.ts";

// The narrowers are the wire contract the bespoke renderers trust — a
// payload that fails them falls back to the generic view, so the tests
// pin both what passes and what fails closed.

describe("tool wire schemas", () => {
	test("search: query in, string-or-error out", () => {
		expect(searchInputSchema.safeParse({ query: "weather" }).success).toBe(true);
		expect(searchInputSchema.safeParse({ query: 42 }).success).toBe(false);
		expect(searchInputSchema.safeParse({}).success).toBe(false);
		expect(searchOutputSchema.safeParse("<web>\n1. t — https://a.dev\n</web>\nnote").success).toBe(
			true,
		);
		expect(
			searchOutputSchema.safeParse({ error: "search is not configured", kind: "unconfigured" })
				.success,
		).toBe(true);
		expect(searchOutputSchema.safeParse({ hits: [] }).success).toBe(false);
	});

	test("fetch: url in; string, refusal, or pdf ref out", () => {
		expect(fetchInputSchema.safeParse({ url: "https://a.dev" }).success).toBe(true);
		expect(fetchInputSchema.safeParse({ url: 7 }).success).toBe(false);
		expect(fetchOutputSchema.safeParse("Source: https://a.dev\n\n<web>\nx\n</web>").success).toBe(
			true,
		);
		expect(fetchOutputSchema.safeParse({ error: "too big", kind: "too-large" }).success).toBe(true);
		expect(
			fetchOutputSchema.safeParse({
				pdf: { path: "/tmp/x.pdf", url: "https://a.dev/x.pdf", size: 12 },
			}).success,
		).toBe(true);
		expect(fetchOutputSchema.safeParse({ pdf: { path: "/x" } }).success).toBe(false);
	});

	test("bash: command in; exit record or spawn error out", () => {
		expect(bashInputSchema.safeParse({ command: "ls" }).success).toBe(true);
		expect(bashInputSchema.safeParse({ cmd: "ls" }).success).toBe(false);
		expect(bashOutputSchema.safeParse({ exit_code: 0, output: "ok" }).success).toBe(true);
		expect(
			bashOutputSchema.safeParse({ exit_code: null, timed_out: true, truncated: true, output: "" })
				.success,
		).toBe(true);
		expect(bashOutputSchema.safeParse({ error: "spawn failed: ENOENT" }).success).toBe(true);
		expect(bashOutputSchema.safeParse({ exit_code: "0", output: "ok" }).success).toBe(false);
		expect(bashOutputSchema.safeParse(null).success).toBe(false);
	});

	test("read_file: path in; content record or error out", () => {
		expect(readInputSchema.safeParse({ path: "src/x.ts" }).success).toBe(true);
		expect(readInputSchema.safeParse({}).success).toBe(false);
		expect(readOutputSchema.safeParse({ content: "1\tx\n", lines: 1, shown: 1 }).success).toBe(
			true,
		);
		expect(readOutputSchema.safeParse({ content: "x" }).success).toBe(false);
		expect(
			readOutputSchema.safeParse({ error: "file not found: x", kind: "not-found" }).success,
		).toBe(true);
	});

	test("edit_file: path+old+new in; replaced count or error out", () => {
		expect(
			editInputSchema.safeParse({
				path: "a.ts",
				old_string: "x",
				new_string: "y",
				replace_all: true,
			}).success,
		).toBe(true);
		expect(editInputSchema.safeParse({ path: "a.ts", old_string: "x" }).success).toBe(false);
		expect(editOutputSchema.safeParse({ path: "/a.ts", replaced: 3 }).success).toBe(true);
		expect(editOutputSchema.safeParse({ error: "old_string not found in a.ts" }).success).toBe(
			true,
		);
		expect(editOutputSchema.safeParse({ replaced: "3" }).success).toBe(false);
	});

	test("write_file: path+content in; byte count or error out", () => {
		expect(writeInputSchema.safeParse({ path: "a.ts", content: "x" }).success).toBe(true);
		expect(writeInputSchema.safeParse({ path: "a.ts" }).success).toBe(false);
		expect(writeOutputSchema.safeParse({ path: "/a.ts", bytes: 2041 }).success).toBe(true);
		expect(writeOutputSchema.safeParse({ bytes: "2041" }).success).toBe(false);
	});
});
