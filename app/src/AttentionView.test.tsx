// Attention is the one place to watch: the operator's open decisions
// above, the cross-project work feed below — its items open the work's
// conversation through the same seam Attention's own items use.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { AttentionView } from "./AttentionView.tsx";
import type { AppAttentionResponse } from "../../src/http/app-wire.ts";

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
const realFetch = globalThis.fetch;
const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	win = new Window({ url: "http://localhost/app/" });
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
	for (const [name, value] of [
		["window", win],
		["document", win.document],
		["navigator", win.navigator],
		["IS_REACT_ACT_ENVIRONMENT", true],
	] as const) {
		globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Reflect.set(globalThis, name, value);
	}
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	await win.happyDOM.close();
	globalThis.fetch = realFetch;
	for (const [name, descriptor] of globals) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
		else Object.defineProperty(globalThis, name, descriptor);
	}
	globals.clear();
});

test("Attention carries the cross-project work feed beneath its decisions", async () => {
	const attention: AppAttentionResponse = { items: [], unavailable: [] };
	const paths: string[] = [];
	globalThis.fetch = Object.assign(
		(input: string | URL | Request) => {
			const path = String(input);
			paths.push(path);
			if (path === "/api/app/attention") return Promise.resolve(Response.json(attention));
			if (path === "/api/app/responsibilities")
				return Promise.resolve(Response.json({ items: [] }));
			return Promise.resolve(Response.json({ error: "not stubbed" }, { status: 404 }));
		},
		{ preconnect: realFetch.preconnect },
	);
	root = createRoot(container);
	await act(async () =>
		root?.render(<AttentionView token={null} onPage={() => {}} onConversation={() => {}} />),
	);
	expect(container.textContent).toContain("Nothing needs you.");
	expect(paths).toContain("/api/app/responsibilities");
});
