import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { openStore, type ConversationStore } from "../../conversation.ts";
import { z } from "zod";
import { excerpt, historyInputSchema, historySearchTool } from "./history.ts";

let dirs: string[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-test-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const exec = (t: ReturnType<typeof historySearchTool>, input: unknown) =>
	// biome-ignore lint: the tool's execute is the boundary under test
	(t as unknown as { execute: (i: unknown) => Promise<unknown> }).execute(input);

const deps = (store: ConversationStore, excluded = false) => ({
	store,
	isExcluded: () => excluded,
});

const msg = (text: string): UIMessage => ({
	id: "m1",
	role: "user",
	parts: [{ type: "text", text }],
});

describe("history_search tool", () => {
	test("provider sees an object schema; missing action arguments still fail validation", () => {
		const wire = z.toJSONSchema(historyInputSchema);
		expect(wire.type).toBe("object");
		expect(wire.properties?.action).toEqual({ type: "string", enum: ["search", "context"] });
		expect(wire.required).toContain("action");
		expect(historyInputSchema.safeParse({}).success).toBe(false);
		expect(historyInputSchema.safeParse({ action: "search" }).success).toBe(false);
		expect(historyInputSchema.safeParse({ action: "search", query: "x" }).success).toBe(true);
		expect(historyInputSchema.safeParse({ action: "context", conversation: "c" }).success)
			.toBe(false);
		expect(historyInputSchema.safeParse({ action: "context", conversation: "c", seq: 1 }).success)
			.toBe(true);
	});
	test("search returns addressable hits with a paging footer", async () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "topic", chatId: -100, threadId: 7 }, "/w");
		store.setMeta(c.id, { title: "Pizza plans" });
		store.append(c.id, [msg("we decided pineapple belongs on pizza")]);
		const out = (await exec(historySearchTool(deps(store)), {
			action: "search",
			query: "pineapple",
		})) as string;
		expect(out).toContain("Pizza plans");
		expect(out).toContain(c.id);
		expect(out).toContain("seq 1");
		expect(out).toContain("pineapple");
		expect(out).toContain('action="context"');
		store.close();
	});

	test("empty is an answer, not an error", async () => {
		const store = openStore(tmpdb());
		const out = (await exec(historySearchTool(deps(store)), {
			action: "search",
			query: "nothing matches this",
		})) as string;
		expect(out).toBe("No past conversations match.");
		store.close();
	});

	test("context pages the window around a hit", async () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.setMeta(c.id, { title: "Plans" });
		store.append(c.id, [msg("first"), msg("second needle"), msg("third")]);
		const out = (await exec(historySearchTool(deps(store)), {
			action: "context",
			conversation: c.id,
			seq: 2,
			window: 1,
		})) as string;
		expect(out).toContain("[Plans]");
		expect(out).toContain("seq 1–3");
		expect(out).toContain("second needle");
		expect(out).toContain("#1");
		expect(out).toContain("#3");
		store.close();
	});

	test("context refuses unknown and excluded conversations", async () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(c.id, [msg("needle here")]);
		const missing = (await exec(historySearchTool(deps(store)), {
			action: "context",
			conversation: "dm:nope",
			seq: 1,
		})) as { error: string };
		expect(missing.error).toContain("no conversation");
		store.setMeta(c.id, { memoryExcluded: true });
		const excluded = (await exec(historySearchTool(deps(store)), {
			action: "context",
			conversation: c.id,
			seq: 1,
		})) as { error: string };
		expect(excluded.error).toContain("excluded");
		store.close();
	});

	test("excluded callers recall nothing by either action", async () => {
		const store = openStore(tmpdb());
		const c = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(c.id, [msg("needle here")]);
		const tool = historySearchTool(deps(store, true));
		const s = (await exec(tool, { action: "search", query: "needle" })) as { error: string };
		expect(s.error).toContain("excluded");
		const ctx = (await exec(tool, { action: "context", conversation: c.id, seq: 1 })) as {
			error: string;
		};
		expect(ctx.error).toContain("excluded");
		store.close();
	});
});

describe("excerpt", () => {
	test("short text passes through verbatim", () => {
		expect(excerpt("hello world", "world")).toBe("hello world");
	});

	test("long text centers on the first term with ellipsis", () => {
		const text = `${"filler ".repeat(100)}needle ${"tail ".repeat(100)}`;
		const out = excerpt(text, "needle");
		expect(out.startsWith("…")).toBe(true);
		expect(out.endsWith("…")).toBe(true);
		expect(out).toContain("needle");
		expect(out.length).toBeLessThan(text.length);
	});

	test("no term landing falls back to the head", () => {
		const text = `alpha ${"filler ".repeat(100)}`;
		expect(excerpt(text, "zzz-no-match")).toBe(`${text.slice(0, 360).trimEnd()}…`);
	});
});
