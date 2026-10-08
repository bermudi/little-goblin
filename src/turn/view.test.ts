// View unit tests: the pure builder's boundary rules
// (design/runtime-turn.md → phase 3) — recall-block interleaving, the
// partial's placement, the compaction boundary shape, render-only
// system events, per-message degradation, and the byte-stability
// prefix property. Cross-turn cache behavior (steering append-only,
// the failed-boundary burst merge) stays pinned e2e in runtime.test.ts.

import { describe, expect, test } from "bun:test";
import type { ModelMessage, UIMessage } from "ai";
import { attachmentPart } from "../agent/attachments.ts";
import type { RecallContext } from "../memory.ts";
import { buildModelView, convertSteeredMessage, type ViewContext } from "./view.ts";

const user = (id: string, text: string): UIMessage => ({
	id,
	role: "user",
	parts: [{ type: "text", text }],
});
const asst = (id: string, text: string): UIMessage => ({
	id,
	role: "assistant",
	parts: [{ type: "text", text }],
});
const entries = (msgs: UIMessage[]) => msgs.map((m, i) => ({ seq: i + 1, message: m }));
const recall = (anchorSeq: number, content: string): RecallContext => ({
	anchorSeq,
	content,
	sourceIds: [`e${anchorSeq}`],
});
// The text of each message, in view order — user messages keep their
// content parts (post-merge) as an array of strings; the placeholder
// and system-event tests read the same projection.
const texts = (view: ModelMessage[]): string[] =>
	view.flatMap((m) =>
		typeof m.content === "string"
			? [m.content]
			: m.content.map((p) => (p as { text: string }).text),
	);

const ctx: ViewContext = { convId: "dm:1", tools: {}, modalities: undefined, carries: () => false };

const build = async (
	entriesList: { seq: number; message: UIMessage }[],
	prior: RecallContext[] = [],
	current: RecallContext | null = null,
	partial: UIMessage | null = null,
): Promise<ModelMessage[]> =>
	buildModelView(ctx, {
		entries: entriesList,
		prior,
		current,
		partial,
		assertAuthority: () => {},
	});

describe("the model view", () => {
	test("recall blocks interleave before their anchored user and fuse with it", async () => {
		const view = await build(
			entries([user("u1", "i like quiet"), asst("a1", "noted"), user("u2", "and dark mode")]),
			[recall(1, "prefers quiet")],
			recall(3, "prefers dark"),
		);
		expect(view.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		// The block leads the anchored user's own text — one merged user
		// message per anchored exchange, memory first.
		expect(texts(view)).toEqual([
			"prefers quiet",
			"i like quiet",
			"noted",
			"prefers dark",
			"and dark mode",
		]);
	});

	test("no recall, no reordering — the view is history's own sequence", async () => {
		const view = await build(
			entries([user("u1", "2+2?"), asst("a1", "answer"), user("u2", "2+5?")]),
		);
		expect(view.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(texts(view)).toEqual(["2+2?", "answer", "2+5?"]);
	});

	test("a resume's partial rides last, as the in-progress assistant message", async () => {
		const partial = asst("p", "half an answ");
		const view = await build(
			entries([user("u1", "question"), asst("a1", "old answer")]),
			[],
			null,
			partial,
		);
		expect(view.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
		expect(texts(view)).toEqual(["question", "old answer", "half an answ"]);
	});

	test("a compaction summary heads the view and never inherits the boundary's block", async () => {
		// The boundary view per DESIGN.md → Compaction: the store's
		// modelEntries mints the summary at the boundary event's seq — a
		// recall block anchored there belongs to the message the summary
		// replaced, and must not ride ahead of it.
		const boundary = [
			{ seq: 2, message: user("compact-2", "[history compacted] earlier days") },
			{ seq: 3, message: user("u3", "fresh question") },
		];
		const view = await build(boundary, [recall(2, "stale evidence")], null);
		expect(view.map((m) => m.role)).toEqual(["user"]);
		expect(texts(view)).toEqual(["[history compacted] earlier days", "fresh question"]);
	});

	test("turn N+1's view is turn N's view with content appended", async () => {
		const turn1 = entries([user("u1", "i like quiet")]);
		const view1 = await build(turn1, [], recall(1, "prefers quiet"));
		const turn2 = entries([
			user("u1", "i like quiet"),
			asst("a1", "noted"),
			user("u2", "and dark mode"),
		]);
		const view2 = await build(turn2, [recall(1, "prefers quiet")], recall(3, "prefers dark"));
		// Byte-stability (DESIGN.md → Cache stability): the prefix
		// survives verbatim; only appended content differs.
		expect(JSON.stringify(view2.slice(0, view1.length))).toBe(JSON.stringify(view1));
	});

	test("a history system event renders as a bracketed user note in position", async () => {
		const event = "saved skill: talk-first — announced in this topic";
		const history = entries([
			asst("a0", "earlier answer"),
			{ id: "sys1", role: "system", parts: [{ type: "text", text: event }] },
			user("u2", "what did you save?"),
		]);
		const view = await build(history);
		expect(view.map((m) => m.role)).toEqual(["assistant", "user"]);
		// The note leads the merged burst's content; the stored role is
		// untouched (render-only mapping).
		expect(texts(view)).toEqual([
			"earlier answer",
			`[system event: ${event}]`,
			"what did you save?",
		]);
	});

	test("an unconvertible message degrades alone — burst-mates keep their text", async () => {
		const poison = {
			id: "poison",
			role: "user",
			parts: [
				{ type: "text", text: "read this" },
				{ type: "file", mediaType: "image/png", filename: "x.png", url: "not a url" },
			],
		} as unknown as UIMessage;
		const view = await build(entries([poison, user("u2", "still there?")]));
		const joined = texts(view).join("\n");
		expect(joined).toContain("could not be prepared for the model (user role)");
		expect(joined).toContain("still there?");
	});

	test("the injected authority re-check runs once and its fence propagates", async () => {
		const sentinel = new Error("fenced");
		let calls = 0;
		await expect(
			buildModelView(ctx, {
				entries: entries([user("u1", "hi")]),
				prior: [],
				current: null,
				partial: null,
				assertAuthority: () => {
					calls++;
					throw sentinel;
				},
			}),
		).rejects.toBe(sentinel);
		expect(calls).toBe(1);
	});
});

describe("the steer variant", () => {
	test("one submit converts through the same gates — a gate-failed attachment degrades to its reference", async () => {
		const message = user("s1", "what is this");
		message.parts.unshift(
			attachmentPart({
				path: "/w/attachments/a.png",
				mediaType: "image/png",
				filename: "a.png",
				size: 9,
			}),
		);
		const view = await convertSteeredMessage(ctx, message);
		expect(view).toHaveLength(1);
		expect(texts(view)).toEqual([
			"[attachment: /w/attachments/a.png — image/png, 9 bytes. Read it with read_file or bash tools.]",
			"what is this",
		]);
	});

	test("an unconvertible submit throws — the poison-pill verdict is the caller's", async () => {
		const poison = {
			id: "poison",
			role: "user",
			parts: [
				{ type: "text", text: "read this" },
				{ type: "file", mediaType: "image/png", filename: "x.png", url: "not a url" },
			],
		} as unknown as UIMessage;
		await expect(convertSteeredMessage(ctx, poison)).rejects.toThrow("Invalid URL");
	});
});
