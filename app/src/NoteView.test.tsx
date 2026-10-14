import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { Editor } from "@milkdown/kit/core";
import { replaceAll } from "@milkdown/kit/utils";
import type { AppNote } from "../../src/http/app-wire.ts";
import { NoteView } from "./NoteView.tsx";

const note: AppNote = {
	id: "n-shopping",
	projectId: null,
	title: "Shopping",
	body: "milk",
	rev: 1,
	stateRev: 1,
	lastSource: "app",
	pinnedAt: null,
	archivedAt: null,
	createdAt: "2026-10-08T00:00:00.000Z",
	updatedAt: "2026-10-09T00:00:00.000Z",
};

interface PatchCall {
	body: { body?: string; title?: string };
	init: RequestInit;
}

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
let installed: string[] = [];
let stored: AppNote;
const patches: PatchCall[] = [];
const milkdowns: Editor[] = [];
const realFetch = globalThis.fetch;
const realMake = Editor.make;

const installGlobal = (name: string, value: unknown) => {
	Reflect.set(globalThis, name, value);
	installed.push(name);
};

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const settle = async () => {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 30));
	});
};

beforeEach(() => {
	win = new Window({ url: "http://localhost/app/n/n-shopping" });
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
	installed = [];
	stored = { ...note };
	patches.length = 0;
	milkdowns.length = 0;
	for (const name of [
		"window",
		"document",
		"navigator",
		"localStorage",
		"Event",
		"ErrorEvent",
		"CustomEvent",
		"MutationObserver",
		"Range",
		"Node",
		"HTMLElement",
		"HTMLUnknownElement",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	] as const) {
		const value = Reflect.get(win as unknown as Record<string, unknown>, name);
		if (value !== undefined) installGlobal(name, value);
	}
	installGlobal("dispatchEvent", win.dispatchEvent.bind(win));
	installGlobal("addEventListener", win.addEventListener.bind(win));
	installGlobal("removeEventListener", win.removeEventListener.bind(win));
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	(Editor as { make: unknown }).make = () => {
		const e = realMake();
		milkdowns.push(e);
		return e;
	};
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		if (url === "/api/app/notes/n-shopping") {
			if (method === "PATCH") {
				const body = JSON.parse(String(init?.body)) as PatchCall["body"];
				patches.push({ body, init: init ?? {} });
				if (body.body !== undefined) stored.body = body.body;
				if (body.title !== undefined) stored.title = body.title;
				// Every accepted mutation moves the token — rev orders
				// content only.
				stored.rev += 1;
				stored.stateRev += 1;
				return Promise.resolve(jsonResponse(stored));
			}
			return Promise.resolve(jsonResponse(stored));
		}
		return Promise.resolve(jsonResponse({ error: `unfaked ${method} ${url}` }, 500));
	}) as typeof fetch;
});

afterEach(async () => {
	if (root !== null) {
		await act(async () => root!.unmount());
		root = null;
	}
	patches.length = 0;
	await win.happyDOM.close();
	(Editor as { make: unknown }).make = realMake;
	for (const name of installed) Reflect.deleteProperty(globalThis, name);
	installed = [];
	globalThis.fetch = realFetch;
});

const mount = async (onChat: (n: AppNote) => void) => {
	root = createRoot(container);
	await act(async () => {
		root!.render(
			<NoteView token={null} noteId={note.id} projects={[]} onChat={onChat} onDeleted={() => {}} />,
		);
	});
	for (let i = 0; i < 30 && container.querySelector(".ProseMirror") === null; i++) {
		await settle();
	}
	expect(container.querySelector(".ProseMirror")).not.toBeNull();
	expect(milkdowns).toHaveLength(1);
};

const editBody = async (md: string) => {
	await act(async () => {
		milkdowns[0]!.action(replaceAll(md));
	});
};

const chatButton = (): HTMLButtonElement =>
	[...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(b) => b.textContent === "Chat with this note",
	)!;

const click = async (el: HTMLButtonElement) => {
	await act(async () => {
		el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
	});
	await settle();
};

const alertText = (): string | null =>
	container.querySelector('p.error[role="alert"]')?.textContent ?? null;

describe("NoteView chat preparation", () => {
	test("a flushAndWait rejection surfaces inline — no mint, buffer stays, button frees", async () => {
		const chats: AppNote[] = [];
		await mount((n) => chats.push(n));
		await editBody("milkx");
		const ed = milkdowns[0]!;
		const origAction = ed.action.bind(ed);
		let armed = true;
		(ed as { action: unknown }).action = (ctx: (c: unknown) => unknown) => {
			if (armed) {
				armed = false;
				throw new Error("injected serializer failure");
			}
			return origAction(ctx);
		};
		const btn = chatButton();
		await click(btn);
		expect(chats).toHaveLength(0);
		expect(patches).toHaveLength(0);
		expect(alertText()).toContain(
			"Couldn't prepare this note for chat: injected serializer failure",
		);
		expect(container.querySelector(".ProseMirror")!.textContent).toContain("milkx");
		expect(btn.disabled).toBe(false);
	});

	test("a throwing onChat surfaces inline — the flush save landed, buffer untouched", async () => {
		let calls = 0;
		await mount(() => {
			calls += 1;
			throw new Error("injected mint failure");
		});
		await editBody("milkx");
		const btn = chatButton();
		await click(btn);
		expect(calls).toBe(1);
		expect(patches).toHaveLength(1);
		expect(patches[0]!.body.body).toContain("milkx");
		expect(alertText()).toContain("Couldn't prepare this note for chat: injected mint failure");
		expect(container.querySelector(".ProseMirror")!.textContent).toContain("milkx");
		expect(btn.disabled).toBe(false);
	});
});
