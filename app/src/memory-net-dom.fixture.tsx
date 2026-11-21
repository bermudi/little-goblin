import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

let win: Window;
let host: HTMLElement;
let root: Root;
const globals = new Map<string, PropertyDescriptor | undefined>();

function Row({ index }: { index: number }) {
	return (
		<li data-row={index}>
			<span>{`row ${index}`}</span>
			<button type="button">open</button>
		</li>
	);
}

beforeEach(async () => {
	win = new Window({ url: "http://localhost/app/" });
	for (const [name, value] of [
		["window", win],
		["document", win.document],
		["navigator", win.navigator],
		["IS_REACT_ACT_ENVIRONMENT", true],
	] as const) {
		globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Reflect.set(globalThis, name, value);
	}
	const container = win.document.createElement("div");
	win.document.body.appendChild(container);
	host = container as unknown as HTMLElement;
	root = createRoot(host);
	await act(async () =>
		root.render(
			<ul>
				{Array.from({ length: 1_000 }, (_, index) => (
					<Row key={index} index={index} />
				))}
			</ul>,
		),
	);
});

afterEach(async () => {
	await act(async () => root.unmount());
	await win.happyDOM.close();
	for (const [name, descriptor] of globals) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
		else Object.defineProperty(globalThis, name, descriptor);
	}
	globals.clear();
});

describe("app runaway", () => {
	test("a failed diff on a mounted node", async () => {
		await expect(
			Promise.resolve({ el: host.querySelector("li") }) as Promise<unknown>,
		).resolves.toEqual(null);
	});
});
