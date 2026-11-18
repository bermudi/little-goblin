import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { checkServer, mount } from "@ui-sdk/core/testing";
import type { AppConversationList } from "../../src/http/app-wire.ts";
import {
	ConversationHierarchy,
	ConversationNav,
	ConversationNavLink,
	ConversationRow,
} from "./ConversationList.tsx";
import { conversationNavigationPrimitive } from "./conversationNavigation.ts";

declare global {
	var __UI_SDK_STRICT__: boolean | undefined;
}

const conv: AppConversationList["conversations"][number] & { parentId: string | null } = {
	id: "app/example",
	title: "Example conversation",
	preview: "A preview",
	createdAt: "2026-10-08T00:00:00.000Z",
	updatedAt: "2026-10-09T00:00:00.000Z",
	archivedAt: null,
	pinnedAt: null,
	projectId: null,
	parentId: null,
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
		["KeyboardEvent", win.KeyboardEvent],
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

const secondConv = { ...conv, id: "app/second", title: "Second conversation" };

function rowElement(conversation = conv) {
	return (
		<ConversationRow
			conv={conversation}
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
	const html = renderToStaticMarkup(
		<ConversationNav loop={false}>
			<li>{rowElement()}</li>
		</ConversationNav>,
	);

	expect(html).toContain('href="/app/c/example"');
	expect(html).toContain('aria-label="Actions for Example conversation"');
	expect(html).not.toContain('role="listbox"');
	expect(html).not.toContain('aria-label="Rename"');
	expect(html).toContain('tabindex="0"');
	expect(html).toContain("<ul");
	expect(html).toContain("<li>");
});

test("arrow keys move between conversation links without replacing list or link semantics", async () => {
	renderRow();
	await act(async () =>
		root?.render(
			<ConversationNav loop={false}>
				<li>{rowElement()}</li>
				<li>{rowElement(secondConv)}</li>
			</ConversationNav>,
		),
	);
	const links = [...container!.querySelectorAll<HTMLAnchorElement>(".conv-main")];
	expect(links.map((link) => link.tabIndex)).toEqual([0, -1]);
	links[0]!.focus();
	await act(async () => {
		links[0]!.dispatchEvent(
			new win!.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event,
		);
	});
	expect(win!.document.activeElement?.getAttribute("href")).toBe("/app/c/second");
	expect(links.map((link) => link.tabIndex)).toEqual([-1, 0]);
	await act(async () => {
		links[1]!.dispatchEvent(
			new win!.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }) as unknown as Event,
		);
	});
	expect(win!.document.activeElement?.getAttribute("href")).toBe("/app/c/example");
	expect(links.map((link) => link.tabIndex)).toEqual([0, -1]);
});

test("the roving-focus primitive keeps one link tabbable and server-renders", async () => {
	const markup =
		'<root><link id="app/one" href="/one">One</link><link id="app/two" href="/two">Two</link></root>';
	setGlobal("__UI_SDK_STRICT__", true);
	expect(checkServer(conversationNavigationPrimitive, { loop: false }, markup)).toContain(
		'tabIndex="0"',
	);
	renderRow();
	const view = mount(conversationNavigationPrimitive, { loop: false }, markup);
	try {
		const first = view.part("link", "app/one")!;
		const second = view.part("link", "app/two")!;
		expect([first.tabIndex, second.tabIndex]).toEqual([0, -1]);
		await view.keys("Tab", "ArrowDown");
		expect(win!.document.activeElement?.getAttribute("href")).toBe("/two");
		expect([first.tabIndex, second.tabIndex]).toEqual([-1, 0]);
		await view.keys("ArrowUp");
		expect(win!.document.activeElement?.getAttribute("href")).toBe("/one");
		expect([first.tabIndex, second.tabIndex]).toEqual([0, -1]);
	} finally {
		view.unmount();
	}
});

test("conversation hierarchy nests children and grandchildren, and labels an orphan", () => {
	const parent = { ...conv, id: "app/parent", title: "Parent" };
	const child = { ...conv, id: "app/child", title: "Child", parentId: parent.id };
	const grandchild = { ...conv, id: "app/grandchild", title: "Grandchild", parentId: child.id };
	const orphan = { ...conv, id: "app/orphan", title: "Orphan", parentId: "app/missing" };
	const html = renderToStaticMarkup(
		<ConversationNav loop={false}>
			<ConversationHierarchy
				conversations={[parent, child, grandchild, orphan]}
				renderItem={(item, isOrphan) => (
					<ConversationNavLink id={item.id} href={`/${item.id}`}>
						{item.title}
						{isOrphan && <span>subagent</span>}
					</ConversationNavLink>
				)}
			/>
		</ConversationNav>,
	);
	expect(html.indexOf("Parent")).toBeLessThan(html.indexOf("Child"));
	expect(html.indexOf("Child")).toBeLessThan(html.indexOf("Grandchild"));
	expect(html).toContain('<ul class="conversation-children"><li><a');
	expect(html).toContain("Orphan<span>subagent</span>");
	expect(html.match(/href="\/app\/child"/)).toHaveLength(1);
	expect(html.match(/href="\/app\/grandchild"/)).toHaveLength(1);
	expect(html.match(/href="\/app\/orphan"/)).toHaveLength(1);
});

test("arrow navigation includes links inside nested conversation lists", async () => {
	const parent = { ...conv, id: "app/parent", title: "Parent" };
	const child = { ...conv, id: "app/child", title: "Child", parentId: parent.id };
	renderRow();
	await act(async () =>
		root?.render(
			<ConversationNav loop={false}>
				<ConversationHierarchy
					conversations={[parent, child]}
					renderItem={(item) => (
						<ConversationNavLink id={item.id} href={`/${item.id}`}>
							{item.title}
						</ConversationNavLink>
					)}
				/>
			</ConversationNav>,
		),
	);
	const links = [...container!.querySelectorAll<HTMLAnchorElement>("a")];
	expect(links.map((link) => link.tabIndex)).toEqual([0, -1]);
	links[0]!.focus();
	await act(async () => {
		links[0]!.dispatchEvent(
			new win!.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event,
		);
	});
	expect(win!.document.activeElement?.getAttribute("href")).toBe("/app/child");
	expect(links.map((link) => link.tabIndex)).toEqual([-1, 0]);
});
