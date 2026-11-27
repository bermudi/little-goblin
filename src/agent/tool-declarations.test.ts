import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Message } from "../message.ts";
import { defineTool } from "../tool.ts";
import {
	ADDITIONAL_TOOLS_PREFIX,
	INCREMENTAL_TOOLS_NOTICE,
	declarationsOf,
	diffDeclarations,
	foldDeclarations,
	isInInputSystem,
	storedToolChanges,
	toolChangeSchema,
	toolRemovalNotice,
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
		const bad = {
			id: "message-1",
			role: "assistant",
			parts: [{ type: "data-tools", data: { added: [{ name: "bad" }], removed: [] } }],
		} as unknown as Message;
		expect(() => storedToolChanges([{ message: bad }], "dm:1")).toThrow(
			/malformed data-tools part in conversation dm:1, message message-1/,
		);
	});

	test("exports exact Codex update notices and identifies flagged system messages", () => {
		expect(INCREMENTAL_TOOLS_NOTICE).toBe(
			"This is an incremental tools update. Previously declared tools remain available unless explicitly marked unavailable. A tool declared again here is available again, and its latest definition replaces the earlier one.",
		);
		expect(toolRemovalNotice(["first", "second"])).toBe(
			"The following tools are no longer available. Do not call them:\n- first\n- second",
		);
		expect(ADDITIONAL_TOOLS_PREFIX).toBe("GOBLIN_ADDITIONAL_TOOLS:");
		expect(isInInputSystem({
			role: "system",
			providerOptions: { codex: { inInput: true } },
		})).toBe(true);
		expect(isInInputSystem({
			role: "system",
			providerOptions: { codex: { inInput: false } },
		})).toBe(false);
		expect(isInInputSystem({
			role: "developer",
			providerOptions: { codex: { inInput: true } },
		})).toBe(false);
	});
});

describe("storedToolChanges", () => {
	test("reads stamps only from assistant replies", () => {
		const stamp = { type: "data-tools", data: { added: [], removed: ["gone"] } };
		const changes = storedToolChanges(
			[
				{ message: { id: "u1", role: "user", parts: [{ type: "data-tools", data: {} }] } as unknown as Message },
				{ message: { id: "a1", role: "assistant", parts: [stamp] } as unknown as Message },
			],
			"dm:1",
		);
		expect(changes).toEqual([{ messageId: "a1", change: { added: [], removed: ["gone"] } }]);
	});
});

