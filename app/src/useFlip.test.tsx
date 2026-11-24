import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFlip } from "./useFlip.ts";

let win: Window | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;
const old = new Map<string, unknown>();

function install(name: string, value: unknown): void {
	old.set(name, Reflect.get(globalThis, name));
	Reflect.set(globalThis, name, value);
}

function setup(reduced = false): { animations: string[] } {
	win = new Window();
	container = win.document.createElement("div") as unknown as HTMLElement;
	win.document.body.appendChild(container as unknown as Parameters<typeof win.document.body.appendChild>[0]);
	for (const [name, value] of [
		["window", win], ["document", win.document], ["navigator", win.navigator],
		["Event", win.Event], ["HTMLElement", win.HTMLElement], ["Element", win.Element],
		["MutationObserver", win.MutationObserver], ["getComputedStyle", win.getComputedStyle],
		["requestAnimationFrame", win.requestAnimationFrame.bind(win)],
		["cancelAnimationFrame", win.cancelAnimationFrame.bind(win)],
	] as const) install(name, value);
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	Reflect.set(win, "matchMedia", () => ({ matches: reduced }));
	const animations: string[] = [];
	Reflect.set(win.Element.prototype, "animate", function(this: HTMLElement, frames: Keyframe[]) {
		animations.push(`${this.dataset.flip}:${frames[0]?.opacity === 0 ? "fade" : "move"}`);
		return {} as Animation;
	});
	root = createRoot(container);
	return { animations };
}

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	container = null;
	for (const [name, value] of old) {
		if (value === undefined) Reflect.deleteProperty(globalThis, name);
		else Reflect.set(globalThis, name, value);
	}
	old.clear();
	win?.close();
	win = null;
	Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

function Fixture({ signature, ids }: { signature: string; ids: string[] }) {
	const ref = useFlip(signature);
	return <ul ref={ref}>{ids.map((id, index) => <li key={id} data-flip={id} data-pos={index} />)}</ul>;
}

test("T27: first mount does not animate, only the moved row animates, and a new row fades", async () => {
	const { animations } = setup();
	Object.defineProperty(win!.HTMLElement.prototype, "offsetTop", {
		configurable: true,
		get() { return Number((this as HTMLElement).dataset.pos); },
	});
	await act(async () => root?.render(<Fixture signature="a,b,c" ids={["a", "b", "c"]} />));
	expect(animations).toEqual([]);
	await act(async () => root?.render(<Fixture signature="a,c" ids={["a", "c"]} />));
	expect(animations).toEqual(["c:move"]);
	await act(async () => root?.render(<Fixture signature="a,c,d" ids={["a", "c", "d"]} />));
	expect(animations).toEqual(["c:move", "d:fade"]);
});

test("T28: reduced motion and a missing animate method do not animate or throw", async () => {
	const { animations } = setup(true);
	await act(async () => root?.render(<Fixture signature="a" ids={["a"]} />));
	await act(async () => root?.render(<Fixture signature="b" ids={["b"]} />));
	expect(animations).toEqual([]);
	Reflect.deleteProperty(win!.Element.prototype, "animate");
	await act(async () => root?.render(<Fixture signature="c" ids={["c"]} />));
	expect(animations).toEqual([]);
});
