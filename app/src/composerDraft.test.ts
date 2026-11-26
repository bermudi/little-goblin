// composerDraft.ts storage contract: drafts round-trip the real
// happy-dom localStorage per scope, an emptied draft leaves no record,
// malformed and foreign records fail loud with FIXED messages that
// never quote stored content, and storage failures surface as
// contextual errors.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { loadComposerDraft, moveComposerDraft, saveComposerDraft } from "./composerDraft.ts";
import { emptyDraft, textDraft, unsentRemainder, type Draft } from "./chat/draft.ts";

const win = new Window();
const storage = win.localStorage;

// The module binds the global at call time — same-origin storage is
// the happy-dom realm's, installed like the mounted composer tests do.
beforeEach(() => {
	Reflect.set(globalThis, "localStorage", storage);
});
afterEach(() => {
	storage.clear();
	Reflect.deleteProperty(globalThis, "localStorage");
});

const KEY = "goblin.composer-draft.v1:app%2Fc-1";

const chipDraft: Draft = {
	items: [
		{ type: "text", text: "look at " },
		{
			type: "chip",
			chip: {
				kind: "file",
				state: "ready",
				ref: {
					path: "attachments/a.png",
					mediaType: "image/png",
					filename: "a.png",
					size: 10,
					transcript: "spoken",
					speech: true,
				},
			},
		},
		{ type: "text", text: " and " },
		{ type: "chip", chip: { kind: "note", id: "n-1", title: "Budget" } },
		{ type: "chip", chip: { kind: "skill", ref: { name: "deploy" } } },
	],
	shelf: [
		{ kind: "file", state: "ready", ref: { path: "attachments/a.png", mediaType: "image/png", filename: "a.png", size: 10, transcript: "spoken", speech: true } },
	],
};

describe("composerDraft", () => {
	test("moveComposerDraft moves the record", () => {
		const draft = textDraft("typed text");
		saveComposerDraft("a", draft);
		expect(moveComposerDraft("a", "b")).toBe(true);
		expect(loadComposerDraft("a")).toBeNull();
		expect(loadComposerDraft("b")).toEqual(draft);
	});

	test("moveComposerDraft with nothing stored is not a failure", () => {
		expect(moveComposerDraft("a", "b")).toBe(true);
		expect(loadComposerDraft("b")).toBeNull();
	});

	test("moveComposerDraft leaves an unreadable source in place", () => {
		storage.setItem("goblin.composer-draft.v1:a", "{not json");
		expect(moveComposerDraft("a", "b")).toBe(false);
		expect(storage.getItem("goblin.composer-draft.v1:a")).toBe("{not json");
		expect(loadComposerDraft("b")).toBeNull();
	});

	test("moveComposerDraft keeps a draft already stored for the destination", () => {
		saveComposerDraft("a", textDraft("typed in the earlier roll"));
		saveComposerDraft("b", textDraft("typed in the empty roll"));
		expect(moveComposerDraft("a", "b")).toBe(true);
		expect(loadComposerDraft("a")).toEqual(textDraft("typed in the earlier roll"));
		expect(loadComposerDraft("b")).toEqual(textDraft("typed in the empty roll"));
	});

	test("moveComposerDraft leaves the source in place when the destination record is unreadable", () => {
		saveComposerDraft("a", textDraft("typed text"));
		storage.setItem("goblin.composer-draft.v1:b", "{not json");
		expect(moveComposerDraft("a", "b")).toBe(false);
		expect(loadComposerDraft("a")).toEqual(textDraft("typed text"));
		expect(storage.getItem("goblin.composer-draft.v1:b")).toBe("{not json");
	});

	test("a draft with chips and shelf round-trips the real localStorage, per scope", () => {
		saveComposerDraft("app/c-1", chipDraft);
		expect(loadComposerDraft("app/c-1")).toEqual(chipDraft);
		expect(loadComposerDraft("app/c-2")).toBeNull();
		expect(storage.getItem(KEY)).toContain("\"version\":2");
	});

	test("quote chips round-trip all fields and an unchanged sent quote has no remainder", () => {
		const draft: Draft = {
			items: [{
				type: "chip",
				chip: {
					kind: "quote",
					id: "quote-1",
					text: "first\nsecond",
					speaker: "assistant",
					messageId: "message-9",
					comment: "keep this in view",
				},
			}],
			shelf: [],
		};
		saveComposerDraft("app/c-1", draft);
		const loaded = loadComposerDraft("app/c-1");
		expect(loaded).toEqual(draft);
		expect(unsentRemainder(loaded as Draft, draft)).toEqual(emptyDraft());
	});

	test("a version 1 text record loads as that text", () => {
		storage.setItem(KEY, JSON.stringify({ version: 1, scope: "app/c-1", text: "half-typed message" }));
		expect(loadComposerDraft("app/c-1")).toEqual(textDraft("half-typed message"));
	});

	test("empty text removes the record — a sent draft leaves no residue", () => {
		saveComposerDraft("new", textDraft("draft"));
		saveComposerDraft("new", textDraft(""));
		expect(loadComposerDraft("new")).toBeNull();
		expect(storage.getItem("goblin.composer-draft.v1:new")).toBeNull();
		saveComposerDraft("new", chipDraft);
		saveComposerDraft("new", emptyDraft());
		expect(storage.getItem("goblin.composer-draft.v1:new")).toBeNull();
	});

	test("a missing record is null, not an error", () => {
		expect(loadComposerDraft("new")).toBeNull();
	});

	test("malformed and foreign records throw FIXED messages — no stored payload leaks, record stays", () => {
		// A JSON.parse error message can quote the stored text — the
		// sentinel must never reach the thrown diagnostic.
		const SENTINEL = "PRIVATE-DRAFT-xyz";
		const malformed = `{"version":2,"scope":"app/c-1","draft":${SENTINEL}`;
		storage.setItem(KEY, malformed);
		const attempt = (): string => {
			try {
				loadComposerDraft("app/c-1");
			} catch (e) {
				return e instanceof Error ? e.message : String(e);
			}
			throw new Error("did not throw");
		};
		expect(attempt()).not.toContain(SENTINEL);
		expect(attempt()).toMatch(/not valid JSON/);
		expect(storage.getItem(KEY)).toBe(malformed);

		// Unknown keys — a strict-shape failure must not echo them.
		storage.setItem(KEY, JSON.stringify({ version: 2, scope: "app/c-1", draft: emptyDraft(), [SENTINEL]: "x" }));
		expect(attempt()).toMatch(/record shape/);
		storage.setItem(KEY, JSON.stringify({ version: 2, scope: "app/c-1", draft: { items: [], shelf: [] }, extra: "y" }));
		expect(attempt()).toMatch(/record shape/);

		// A record under another composer's scope never reads as this
		// one's draft.
		storage.setItem(KEY, JSON.stringify({ version: 2, scope: "elsewhere", draft: emptyDraft() }));
		expect(attempt()).toMatch(/different composer/);
		storage.setItem(KEY, JSON.stringify({ version: 1, scope: "elsewhere", text: "x" }));
		expect(attempt()).toMatch(/different composer/);
	});

	test("a failing localStorage surfaces as a contextual error", () => {
		Reflect.set(globalThis, "localStorage", {
			getItem: () => {
				throw new Error("quota boom");
			},
			setItem: () => {
				throw new Error("quota boom");
			},
			removeItem: () => {
				throw new Error("quota boom");
			},
		});
		expect(() => loadComposerDraft("new")).toThrow(/localStorage read failed: quota boom/);
		expect(() => saveComposerDraft("new", textDraft("x"))).toThrow(/localStorage write failed: quota boom/);
		expect(() => saveComposerDraft("new", textDraft(""))).toThrow(/localStorage delete failed: quota boom/);
	});
});
