import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { loadSideChatsOpen, saveSideChatsOpen } from "./railFolders.ts";

let win: Window | null = null;
const oldStorage = Reflect.get(globalThis, "localStorage");

afterEach(() => {
	if (win !== null) win.close();
	win = null;
	if (oldStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
	else Reflect.set(globalThis, "localStorage", oldStorage);
});

function storage() {
	win = new Window();
	Reflect.set(globalThis, "localStorage", win.localStorage);
	return win.localStorage;
}


test("side chats load closed until saved open", () => {
	storage();
	expect(loadSideChatsOpen()).toBe(false);
	saveSideChatsOpen(true);
	expect(loadSideChatsOpen()).toBe(true);
	saveSideChatsOpen(false);
	expect(loadSideChatsOpen()).toBe(false);
});
