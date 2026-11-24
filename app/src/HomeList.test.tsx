import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppConversationList } from "../../src/http/app-wire.ts";
import { ConversationNavLink, ConversationRow } from "./ConversationList.tsx";
import { HomeList, useHomeList } from "./HomeList.tsx";
import { buildHome, type HomeInput } from "./homeList.ts";

type Conv = AppConversationList["conversations"][number];
const at = "2026-01-01T00:00:00Z";
const conv = (id: string, parentId: string | null = null): Conv => ({
	id: `app/${id}`,
	title: id,
	preview: `${id} preview`,
	createdAt: at,
	updatedAt: at,
	archivedAt: null,
	pinnedAt: null,
	projectId: null,
	parentId,
	newReply: null,
	busy: false,
});
const input = (conversations: Conv[], open: string | null = null): HomeInput => ({
	conversations,
	chain: [],
	projects: [],
	attention: conversations.some((row) => row.id === "app/needs") ? [{
		id: "needs",
		kind: "program-approval",
		title: "Needs review",
		detail: "Evidence",
		createdAt: at,
		conversationId: "app/needs",
		target: { kind: "page", page: "programs" },
	}] : [],
	delegations: [],
	open,
	openRoll: null,
	seen: null,
});

let win: Window | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;
const old = new Map<string, unknown>();

function setGlobal(name: string, value: unknown): void {
	old.set(name, Reflect.get(globalThis, name));
	Reflect.set(globalThis, name, value);
}

function setup(): void {
	win = new Window();
	container = win.document.createElement("div") as unknown as HTMLElement;
	win.document.body.appendChild(container as unknown as Parameters<typeof win.document.body.appendChild>[0]);
	for (const [name, value] of [
		["window", win],
		["document", win.document],
		["navigator", win.navigator],
		["Event", win.Event],
		["KeyboardEvent", win.KeyboardEvent],
		["NodeFilter", win.NodeFilter],
		["HTMLElement", win.HTMLElement],
		["HTMLFieldSetElement", win.HTMLFieldSetElement],
		["HTMLInputElement", win.HTMLInputElement],
		["HTMLTextAreaElement", win.HTMLTextAreaElement],
		["MutationObserver", win.MutationObserver],
		["Element", win.Element],
		["getComputedStyle", win.getComputedStyle],
		["requestAnimationFrame", win.requestAnimationFrame.bind(win)],
		["cancelAnimationFrame", win.cancelAnimationFrame.bind(win)],
	] as const) setGlobal(name, value);
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	root = createRoot(container);
}

afterEach(async () => {
	if (root !== null) await act(async () => root?.unmount());
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

test("T21: HomeList fold starts closed, opens, exposes kid links in arrow order, and defaults open for the open kid", async () => {
	const parent = conv("parent");
	const kid = { ...conv("kid", parent.id), busy: true };
	const secondKid = conv("second-kid", parent.id);
	const sibling = conv("sibling");
	setup();
	function Fixture({ open }: { open: string | null }) {
		const data = input([parent, kid, secondKid, sibling], open);
		const home = useHomeList(data, [], true);
		return <HomeList
			home={home}
			projects={[]}
			projectsOpen
			currentFolderId={null}
			rollingCurrent={false}
			onToggleProjects={() => {}}
			onNewProject={() => {}}
			onOpenProject={() => {}}
			onOpenTarget={() => {}}
			onOpenRolling={() => {}}
			renderRow={(row) => <ConversationNavLink className="conv-main" id={row.id} href={`/app/c/${row.id.slice(4)}`}>{row.title}</ConversationNavLink>}
		/>;
	}
	await act(async () => root?.render(<Fixture open={null} />));
	let fold = container!.querySelector<HTMLButtonElement>(".kidtoggle")!;
	expect(fold.getAttribute("aria-expanded")).toBe("false");
	expect(fold.getAttribute("aria-controls")).toBeNull();
	expect(fold.textContent).toContain("2 subagents");
	await act(async () => fold.click());
	fold = container!.querySelector<HTMLButtonElement>(".kidtoggle")!;
	expect(fold.getAttribute("aria-expanded")).toBe("true");
	expect(fold.getAttribute("aria-controls")).not.toBeNull();
	const links = [...container!.querySelectorAll<HTMLAnchorElement>(".conv-main")];
	expect(links.map((link) => link.textContent)).toContain("kid");
	const parentLink = links.find((link) => link.textContent === "parent")!;
	parentLink.focus();
	await act(async () => parentLink.dispatchEvent(new win!.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event));
	expect(win!.document.activeElement?.textContent).toBe("kid");
	await act(async () => fold.click());
	await act(async () => root?.render(<Fixture open={kid.id} />));
	fold = container!.querySelector<HTMLButtonElement>(".kidtoggle")!;
	expect(fold.getAttribute("aria-expanded")).toBe("false");
	await act(async () => root?.unmount());
	root = createRoot(container!);
	await act(async () => root?.render(<Fixture open={kid.id} />));
	fold = container!.querySelector<HTMLButtonElement>(".kidtoggle")!;
	expect(fold.getAttribute("aria-expanded")).toBe("true");
});

test("T22: each mark has its own shape and words; no mark, no data-mark; a finished subagent says Done", () => {
	const list = buildHome(input([
		conv("needs"),
		{ ...conv("new"), newReply: 1 },
		{ ...conv("working"), busy: true },
		conv("finished", "app/working"),
		{ ...conv("running", "app/working"), busy: true },
		conv("plain"),
	]), null).list;
	const html = renderToStaticMarkup(<HomeList
		home={{ list, orderSignature: "", isExpanded: () => true, toggle: () => {} }}
		projects={[]}
		projectsOpen={false}
		currentFolderId={null}
		rollingCurrent={false}
		onToggleProjects={() => {}}
		onNewProject={() => {}}
		onOpenProject={() => {}}
		onOpenTarget={() => {}}
		onOpenRolling={() => {}}
		renderRow={(row, options) => (
			<ConversationRow
				conv={row}
				{...options}
				current={null}
				token={null}
				moveTargets={[]}
				onOpen={() => {}}
				onRenamed={() => {}}
				onToggleArchived={() => {}}
				onTogglePinned={() => {}}
				onDelete={() => {}}
				onError={() => {}}
				onMove={() => {}}
				onMoveToNewProject={() => {}}
			/>
		)}
	/>);
	const page = new Window().document;
	page.body.innerHTML = html;
	const rowOf = (id: string) => {
		const row = page.querySelector(`[href="/app/c/${id}"]`)?.closest(".conv");
		return {
			mark: row?.getAttribute("data-mark") ?? null,
			shape: row?.querySelector(".mark")?.className ?? null,
			words: row?.querySelector(".sr-only")?.textContent ?? null,
			line: row?.querySelector(".conv-preview")?.textContent ?? null,
		};
	};
	expect(rowOf("needs")).toEqual({
		mark: "needs", shape: "mark mark-needs", words: "Needs you", line: "Needs review",
	});
	expect(rowOf("new")).toEqual({
		mark: "new", shape: "mark mark-new", words: "New reply", line: "new preview",
	});
	expect(rowOf("working")).toEqual({
		mark: "working", shape: "mark mark-working", words: "Working", line: "Working",
	});
	expect(rowOf("running")).toEqual({
		mark: "working", shape: "mark mark-working", words: "Working", line: null,
	});
	expect(rowOf("finished")).toEqual({
		mark: null, shape: "mark mark-done", words: "Done", line: null,
	});
	expect(rowOf("plain")).toEqual({
		mark: null, shape: null, words: null, line: "plain preview",
	});
});
