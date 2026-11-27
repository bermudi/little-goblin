import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readHeaderLayout } from "./headerLayout.ts";

const oldWindow = globalThis.window;
const oldLocation = globalThis.location;
const oldStorage = globalThis.localStorage;

afterEach(() => {
	if (oldWindow === undefined) Reflect.deleteProperty(globalThis, "window");
	else Reflect.set(globalThis, "window", oldWindow);
	if (oldLocation === undefined) Reflect.deleteProperty(globalThis, "location");
	else Reflect.set(globalThis, "location", oldLocation);
	if (oldStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
	else Reflect.set(globalThis, "localStorage", oldStorage);
});

test("query selects and stores a layout, stored valid value is reused, invalid value falls back", () => {
	const win = new Window({ url: "http://localhost/app/c/one?header=b" });
	Reflect.set(globalThis, "window", win);
	Reflect.set(globalThis, "location", win.location);
	Reflect.set(globalThis, "localStorage", win.localStorage);
	expect(readHeaderLayout()).toBe("b");
	expect(win.localStorage.getItem("goblin.headerLayout")).toBe("b");
	win.history.replaceState({}, "", "/app/c/one");
	expect(readHeaderLayout()).toBe("b");
	win.localStorage.setItem("goblin.headerLayout", "garbage");
	expect(readHeaderLayout()).toBe("a");
	win.close();
});
