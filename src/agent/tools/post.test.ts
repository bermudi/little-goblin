import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { makePosts, POST_MAX_CHARS } from "../../posts.ts";
import { postTool } from "./post.ts";

function rig() {
	const posts = makePosts(new Database(":memory:"), () => new Date("2026-11-22T08:00:00.000Z"));
	const tool = postTool({ posts, conversationId: "app/nightly" });
	return { posts, run: (input: unknown) => tool.execute(input as { text: string }, { toolCallId: "call-1" }) };
}

test("post stores trimmed text under the calling conversation", async () => {
	const { posts, run } = rig();
	expect(await run({ text: "  Disk is 91% full.\n" })).toEqual({ id: 1, createdAt: "2026-11-22T08:00:00.000Z" });
	expect(posts.recent(5)).toEqual([
		{ id: 1, conversationId: "app/nightly", text: "Disk is 91% full.", createdAt: "2026-11-22T08:00:00.000Z" },
	]);
});

test("post refuses blank and overlong text and stores nothing", async () => {
	const { posts, run } = rig();
	expect(await run({ text: "   " })).toEqual({ error: "a post needs text" });
	expect(() => run({ text: "x".repeat(POST_MAX_CHARS + 1) })).toThrow();
	expect(posts.recent(5)).toEqual([]);
});
