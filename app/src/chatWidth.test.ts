// chatWidth.ts contract: the preference round-trips real localStorage,
// missing or unrecognized records read as the narrow default, and
// storage being unavailable only costs the memory of it — a preference,
// not state (speech.tsx's rate ruling).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { loadChatWidth, saveChatWidth } from "./chatWidth.ts";

const win = new Window();
const storage = win.localStorage;

beforeEach(() => {
	Reflect.set(globalThis, "localStorage", storage);
});
afterEach(() => {
	storage.clear();
	Reflect.deleteProperty(globalThis, "localStorage");
});

describe("chatWidth", () => {
	test("a choice round-trips and missing reads as narrow", () => {
		expect(loadChatWidth()).toBe("narrow");
		saveChatWidth("wide");
		expect(loadChatWidth()).toBe("wide");
		saveChatWidth("narrow");
		expect(loadChatWidth()).toBe("narrow");
	});

	test("an unrecognized record reads as the default, not an error", () => {
		storage.setItem("goblin.chat-width.v1", "maximal");
		expect(loadChatWidth()).toBe("narrow");
	});

	test("storage being unavailable costs only the memory of it", () => {
		Reflect.set(globalThis, "localStorage", {
			getItem: () => {
				throw new Error("quota boom");
			},
			setItem: () => {
				throw new Error("quota boom");
			},
		});
		expect(loadChatWidth()).toBe("narrow");
		expect(() => saveChatWidth("wide")).not.toThrow();
	});
});
