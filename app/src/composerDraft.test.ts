// composerDraft.ts storage contract: drafts round-trip the real
// happy-dom localStorage per scope, an emptied draft leaves no record,
// malformed and foreign records fail loud with FIXED messages that
// never quote stored content, and storage failures surface as
// contextual errors.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { loadComposerDraft, saveComposerDraft } from "./composerDraft.ts";

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

describe("composerDraft", () => {
	test("a draft round-trips the real localStorage, per scope", () => {
		saveComposerDraft("app/c-1", "half-typed message");
		expect(loadComposerDraft("app/c-1")).toBe("half-typed message");
		expect(loadComposerDraft("app/c-2")).toBeNull();
	});

	test("empty text removes the record — a sent draft leaves no residue", () => {
		saveComposerDraft("new", "draft");
		saveComposerDraft("new", "");
		expect(loadComposerDraft("new")).toBeNull();
		expect(storage.getItem("goblin.composer-draft.v1:new")).toBeNull();
	});

	test("a missing record is null, not an error", () => {
		expect(loadComposerDraft("new")).toBeNull();
	});

	test("malformed and foreign records throw FIXED messages — no stored payload leaks, record stays", () => {
		// A JSON.parse error message can quote the stored text — the
		// sentinel must never reach the thrown diagnostic.
		const SENTINEL = "PRIVATE-DRAFT-xyz";
		const malformed = `{"version":1,"scope":"app/c-1","text":"${SENTINEL}`;
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
		storage.setItem(KEY, JSON.stringify({ version: 1, scope: "app/c-1", [SENTINEL]: "x" }));
		expect(attempt()).toMatch(/record shape/);

		// A record under another composer's scope never reads as this
		// one's draft.
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
		expect(() => saveComposerDraft("new", "x")).toThrow(/localStorage write failed: quota boom/);
		expect(() => saveComposerDraft("new", "")).toThrow(/localStorage delete failed: quota boom/);
	});
});
