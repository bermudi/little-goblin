import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppConversationList } from "../../src/http/app-wire.ts";
import { ConversationRow } from "./ConversationList.tsx";

const conv: AppConversationList["conversations"][number] = {
	id: "app/example",
	title: "Example conversation",
	preview: "A preview",
	createdAt: "2026-10-08T00:00:00.000Z",
	updatedAt: "2026-10-09T00:00:00.000Z",
	archivedAt: null,
	pinnedAt: null,
	projectId: null,
};

let win: Window | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;
const oldGlobals = new Map<string, unknown>();

function setGlobal(name: string, value: unknown): void {
	oldGlobals.set(name, Reflect.get(globalThis, name));
	Reflect.set(globalThis, name, value);
}

afterEach(async () => {
	if (root !== null) await act(async () => root?.unmount());
	root = null;
	container = null;
	for (const [name, value] of oldGlobals) {
		if (value === undefined) Reflect.deleteProperty(globalThis, name);
		else Reflect.set(globalThis, name, value);
	}
	oldGlobals.clear();
	win?.close();
	win = null;
	Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

function renderRow() {
	win = new Window();
	container = win.document.createElement("div") as unknown as HTMLElement;
	win.document.body.appendChild(
		container as unknown as Parameters<typeof win.document.body.appendChild>[0],
	);
	for (const [name, value] of [
		["window", win],
		["document", win.document],
		["navigator", win.navigator],
		["Event", win.Event],
		["NodeFilter", win.NodeFilter],
		["HTMLElement", win.HTMLElement],
		["MutationObserver", win.MutationObserver],
		["Element", win.Element],
		["getComputedStyle", win.getComputedStyle],
		["requestAnimationFrame", win.requestAnimationFrame.bind(win)],
		["cancelAnimationFrame", win.cancelAnimationFrame.bind(win)],
	] as const) {
		setGlobal(name, value);
	}
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	root = createRoot(container);
}

function rowElement() {
	return (
		<ConversationRow
			conv={conv}
			current={null}
			onOpen={() => {}}
			onRenamed={() => {}}
			onToggleArchived={() => {}}
			onTogglePinned={() => {}}
			onDelete={() => {}}
			onError={() => {}}
			token={null}
		/>
	);
}

test("conversation row keeps link navigation and groups actions in one named menu trigger", () => {
	const html = renderToStaticMarkup(rowElement());

	expect(html).toContain('<a class="conv-main" href="/app/c/example">');
	expect(html).toContain('aria-label="Actions for Example conversation"');
	expect(html).not.toContain('role="listbox"');
	expect(html).not.toContain('aria-label="Rename"');
});

test("the action trigger opens the ui-sdk menu with arrow-key navigation", async () => {
	renderRow();
	await act(async () => root?.render(rowElement()));
	const trigger = container?.querySelector<HTMLButtonElement>(".conv-menu-trigger");
	expect(trigger).not.toBeNull();
	await act(async () => {
		trigger?.dispatchEvent(
			new win!.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event,
		);
	});
	expect(container?.querySelector('[role="menu"]')).not.toBeNull();
	expect([...container!.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
		"Pin",
		"Rename",
		"Archive",
	]);
});
