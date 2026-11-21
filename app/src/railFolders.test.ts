import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { loadOpenFolders, saveOpenFolders } from "./railFolders.ts";

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

test("open folders round-trip through localStorage", () => {
	storage();
	saveOpenFolders(new Set(["p-one", "p-two"]));
	expect(loadOpenFolders()).toEqual(new Set(["p-one", "p-two"]));
});

test("missing and invalid stored values load as empty", () => {
	const store = storage();
	expect(loadOpenFolders()).toEqual(new Set());
	store.setItem("goblin.rail-folders.v1", "not json");
	expect(loadOpenFolders()).toEqual(new Set());
	store.setItem("goblin.rail-folders.v1", '{"a":1}');
	expect(loadOpenFolders()).toEqual(new Set());
});

test("throwing storage loads empty and save is best-effort", () => {
	Reflect.set(globalThis, "localStorage", {
		getItem() {
			throw new Error("blocked");
		},
		setItem() {
			throw new Error("blocked");
		},
	});
	expect(loadOpenFolders()).toEqual(new Set());
	expect(() => saveOpenFolders(new Set(["p-one"]))).not.toThrow();
});
