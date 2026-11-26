import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineTool } from "../tool.ts";
import {
	declarationsOf,
	diffDeclarations,
	foldDeclarations,
	toolChangeSchema,
	type ToolChange,
	type ToolDeclaration,
} from "./tool-declarations.ts";

const tool = (description: string) =>
	defineTool({
		description,
		input: z.object({ value: z.string() }),
		execute: ({ value }) => value,
	});

describe("tool declarations", () => {
	test("diffs additions, redefinitions, removals, and no-op state", () => {
		const first = declarationsOf({ one: tool("first") });
		const previous = new Map(first.map((declaration) => [declaration.name, declaration]));
		const next = declarationsOf({ one: tool("second"), two: tool("new") });
		expect(diffDeclarations(new Map(), first)).toEqual({ added: [first[0]!], removed: [] });
		expect(diffDeclarations(previous, next)).toEqual({
			added: [next[0]!, next[1]!],
			removed: [],
		});
		expect(diffDeclarations(previous, [])).toEqual({ added: [], removed: ["one"] });
		expect(diffDeclarations(previous, first)).toBeNull();
	});

	test("folds in order and replaces a declaration by name", () => {
		const [one] = declarationsOf({ one: tool("first") });
		const [replacement] = declarationsOf({ one: tool("third") });
		const changed: ToolDeclaration = { ...one!, description: "second" };
		const changes: ToolChange[] = [
			{ added: [one!], removed: [] },
			{ added: [changed], removed: [] },
			{ added: [replacement!], removed: ["one"] },
		];
		expect(foldDeclarations(changes)).toEqual(new Map([["one", replacement!]]));
	});

	test("rejects malformed stored changes", () => {
		expect(toolChangeSchema.safeParse({ added: [{ name: "bad" }], removed: [] }).success).toBe(false);
	});
});
