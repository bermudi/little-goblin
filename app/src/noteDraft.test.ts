// noteDraft.ts storage contract: a >80KiB body round-trips through the
// real happy-dom localStorage, malformed and foreign records fail loud
// with FIXED messages that never quote stored content, compare-delete
// refuses a snapshot that isn't stored, the expected-snapshot write
// guards ownership, and storage failures surface as contextual errors.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { clearNoteDraft, loadNoteDraft, writeNoteDraft, type NoteDraft } from "./noteDraft.ts";

const win = new Window();
const storage = win.localStorage;

// The module binds the global at call time — same-origin storage is
// the happy-dom realm's, installed like the mounted editor tests do.
beforeEach(() => {
	Reflect.set(globalThis, "localStorage", storage);
});
afterEach(() => {
	storage.clear();
	Reflect.deleteProperty(globalThis, "localStorage");
});

const KEY = "goblin.note-draft.v1:n-1";

const draft = (over: Partial<NoteDraft> = {}): NoteDraft => ({
	version: 1,
	noteId: "n-1",
	baseRev: 1,
	baseBody: "server body",
	body: "local edits",
	...over,
});

describe("noteDraft", () => {
	test("a >80KiB draft round-trips the real localStorage", () => {
		const big = "x".repeat(90 * 1024);
		const snap = writeNoteDraft(draft({ body: big }));
		const loaded = loadNoteDraft("n-1");
		expect(loaded?.draft.body).toBe(big);
		expect(loaded?.snapshot).toBe(snap);
		clearNoteDraft("n-1", snap);
		expect(loadNoteDraft("n-1")).toBeNull();
	});

	test("a missing record is null, not an error", () => {
		expect(loadNoteDraft("no-such-note")).toBeNull();
	});

	test("malformed and foreign records throw FIXED messages — no stored payload leaks, record stays", () => {
		// A JSON.parse error message can quote the stored text — the
		// sentinel must never reach the thrown diagnostic.
		const SENTINEL = "PRIVATE-BODY-xyz";
		const malformed = `{"version":1,"noteId":"n-1","body":"${SENTINEL}`;
		storage.setItem(KEY, malformed);
		const badJson = (): string => {
			try {
				loadNoteDraft("n-1");
			} catch (e) {
				return e instanceof Error ? e.message : String(e);
			}
			throw new Error("did not throw");
		};
		expect(badJson()).not.toContain(SENTINEL);
		expect(badJson()).toMatch(/not valid JSON/);
		expect(storage.getItem(KEY)).toBe(malformed);

		// Unknown keys — a strict-shape failure must not echo them.
		storage.setItem(KEY, JSON.stringify({ ...draft(), [SENTINEL]: "x" }));
		expect(badJson()).toMatch(/record shape/);
		expect(badJson()).not.toContain(SENTINEL);
		expect(storage.getItem(KEY)).not.toBeNull();

		// A foreign note's id is stored data — the mismatch error
		// must not echo it either.
		storage.setItem(KEY, JSON.stringify(draft({ noteId: SENTINEL })));
		expect(badJson()).toMatch(/different note/);
		expect(badJson()).not.toContain(SENTINEL);
		expect(storage.getItem(KEY)).not.toBeNull();
		storage.removeItem(KEY);
	});

	test("clearNoteDraft deletes only the exact snapshot it was given", () => {
		const snap = writeNoteDraft(draft({ body: "v1" }));
		// A newer capture lands — the stale snapshot must not delete it.
		writeNoteDraft(draft({ body: "v2" }));
		clearNoteDraft("n-1", snap);
		expect(loadNoteDraft("n-1")?.draft.body).toBe("v2");
		// The current snapshot deletes.
		clearNoteDraft("n-1", JSON.stringify(draft({ body: "v2" })));
		expect(loadNoteDraft("n-1")).toBeNull();
		// Clearing what isn't there is a no-op, not an error.
		clearNoteDraft("n-1", snap);
	});

	test("the expected-snapshot write refuses to overwrite a newer record", () => {
		const snap = writeNoteDraft(draft({ body: "v1" }));
		// Storage still holds our snapshot — the guarded write lands.
		expect(writeNoteDraft(draft({ body: "v2" }), snap)).toBe(JSON.stringify(draft({ body: "v2" })));
		// A newer record moved in — the stale owner's write is refused.
		writeNoteDraft(draft({ body: "v3" }));
		expect(writeNoteDraft(draft({ body: "v2" }), JSON.stringify(draft({ body: "v2" })))).toBeNull();
		expect(loadNoteDraft("n-1")?.draft.body).toBe("v3");
	});

	test("storage denial surfaces a contextual error", () => {
		const original = Reflect.get(globalThis, "localStorage");
		Reflect.set(globalThis, "localStorage", {
			getItem: storage.getItem.bind(storage),
			setItem: () => {
				throw new DOMException("quota exceeded", "QuotaExceededError");
			},
			removeItem: storage.removeItem.bind(storage),
		});
		try {
			expect(() => writeNoteDraft(draft())).toThrow(/localStorage write failed.*quota/);
		} finally {
			Reflect.set(globalThis, "localStorage", original);
		}
	});
});
