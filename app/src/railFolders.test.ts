import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { loadProjectsOpen, saveProjectsOpen } from "./railFolders.ts";

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

test("the projects section loads closed until saved open", () => {
	storage();
	expect(loadProjectsOpen()).toBe(false);
	saveProjectsOpen(true);
	expect(loadProjectsOpen()).toBe(true);
	saveProjectsOpen(false);
	expect(loadProjectsOpen()).toBe(false);
});
