// The note page's own contracts: an archived note is read-only and
// cannot start a note-bound chat (intake would 422 the empty
// conversation's first message), and the leave guard's dirty report
// reaches the App — an unsaved title/body or a standing conflict must
// never die silently on navigation.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createRef, forwardRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { AppNote, AppNoteSummary } from "../../src/http/app-wire.ts";

// The lazy editor resolves to Milkdown — its timers outlive this file
// and fire inside other suites' processes, where the browser globals
// it dereferences don't exist. The page contract these tests pin —
// readonly/archived and the dirty report — lives outside the editor:
// a stub stands in.
void mock.module("./NoteEditor.tsx", () => ({
	default: forwardRef((_props: Record<string, unknown>, _ref: unknown) => null),
}));

import { NoteView, NotesIndex } from "./NoteView.tsx";

const NOTE: AppNote = {
	id: "n1",
	projectId: null,
	title: "scratch",
	body: "draft body",
	rev: 3,
	lastSource: "app",
	pinnedAt: null,
	archivedAt: null,
	createdAt: "2026-10-10T00:00:00Z",
	updatedAt: "2026-10-10T00:00:00Z",
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("NoteView", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	let note: AppNote;
	const realFetch = globalThis.fetch;

	const installGlobal = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	beforeEach(() => {
		win = new Window();
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		installed = [];
		note = NOTE;
		for (const [name, value] of [
			["window", win],
			["document", win.document],
			["navigator", win.navigator],
			["localStorage", win.localStorage],
			["Event", win.Event],
			["CustomEvent", win.CustomEvent],
			["getComputedStyle", win.getComputedStyle],
		] as const) {
			installGlobal(name, value);
		}
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === `/api/app/notes/${note.id}` && init?.method === undefined) {
				return Promise.resolve(
					new Response(JSON.stringify(note), {
						headers: { "content-type": "application/json", etag: '"3"' },
					}),
				);
			}
			if (url === "/api/app/notes/versions") return Promise.resolve(jsonResponse({ versions: [] }));
			return Promise.resolve(jsonResponse({ error: "unstubbed fetch" }, 404));
		}) as typeof fetch;
	});

	afterEach(async () => {
		if (root !== null) {
			await act(async () => {
				root?.unmount();
			});
			root = null;
		}
		await win.happyDOM.close();
		globalThis.fetch = realFetch;
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		for (const name of installed) Reflect.deleteProperty(globalThis, name);
		installed = [];
	});

	const settle = async () => {
		await act(async () => {
			await new Promise((r) => setTimeout(r, 30));
		});
	};
	const waitFor = async (pred: () => boolean, label: string) => {
		for (let i = 0; i < 100; i++) {
			if (pred()) return;
			await settle();
		}
		throw new Error(`timed out waiting for ${label}`);
	};
	const mount = async (el: ReactNode) => {
		root = createRoot(container);
		await act(async () => {
			root?.render(el);
		});
		await waitFor(() => container.querySelector(".note-title") !== null, "the loaded note page");
	};

	test("an archived note renders read-only and cannot start a chat", async () => {
		note = { ...NOTE, archivedAt: "2026-10-11T00:00:00Z" };
		let chatted = false;
		await mount(
			<NoteView
				token={null}
				noteId="n1"
				projects={[]}
				onChat={() => {
					chatted = true;
				}}
				onDeleted={() => {}}
			/>,
		);
		// No editor, no title edit — the archived body is a document,
		// not a draft.
		expect(container.querySelector(".note-readonly")?.textContent).toBe("draft body");
		expect(container.querySelector<HTMLInputElement>(".note-title")?.disabled).toBe(true);
		const chat = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
			b.textContent?.includes("Chat with this note"),
		);
		expect(chat?.disabled).toBe(true);
		await act(async () => {
			chat?.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
		});
		expect(chatted).toBe(false);
	});

	test("a title edit reports dirty to the App and a clean page reports clean — unmount resets", async () => {
		const reports: boolean[] = [];
		await mount(
			<NoteView
				token={null}
				noteId="n1"
				projects={[]}
				onChat={() => {}}
				onDeleted={() => {}}
				onDirtyChange={(d) => reports.push(d)}
			/>,
		);
		expect(reports).toEqual([false]);
		const title = container.querySelector<HTMLInputElement>(".note-title")!;
		const typeTitle = async (value: string) => {
			await act(async () => {
				// The native setter + focus/keyup — React's tracked-value
				// input skips a plain .value assignment (App.test's ruling).
				title.focus();
				Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(
					title,
					value,
				);
				title.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
				title.dispatchEvent(
					new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
				);
			});
			await settle();
		};
		await typeTitle("scratch — edited");
		expect(reports.at(-1)).toBe(true);
		await typeTitle("scratch");
		expect(reports.at(-1)).toBe(false);
		await act(async () => {
			root?.unmount();
		});
		root = null;
		expect(reports.at(-1)).toBe(false);
	});

	test("confirmed discard clears a title draft before a trailing blur can save it", async () => {
		const discard = createRef<(() => void) | null>();
		let patches = 0;
		const fetchPage = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "PATCH") patches++;
				return fetchPage(input, init);
			},
			{ preconnect: realFetch.preconnect },
		);
		await mount(
			<NoteView
				token={null}
				noteId="n1"
				projects={[]}
				onChat={() => {}}
				onDeleted={() => {}}
				discardRef={discard}
			/>,
		);
		const title = container.querySelector<HTMLInputElement>(".note-title")!;
		await act(async () => {
			title.focus();
			Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(
				title,
				"discarded title",
			);
			title.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			title.dispatchEvent(
				new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
			);
		});
		expect(title.value).toBe("discarded title");
		expect(discard.current).not.toBeNull();
		await act(async () => {
			discard.current?.();
			title.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
		});
		expect(patches).toBe(0);
		expect(title.value).toBe(note.title);
		await act(async () => root?.unmount());
		root = null;
		expect(discard.current).toBeNull();
	});
});

// The index's truncation contract (design/projects.md → HTTP surface):
// each list's own `truncated` bit decides the notice — the client
// never re-derives it from row counts.
describe("NotesIndex", () => {
	const SUMMARY: AppNoteSummary = {
		id: "n1",
		projectId: null,
		title: "scratch",
		rev: 1,
		pinnedAt: null,
		archivedAt: null,
		updatedAt: "2026-10-10T00:00:00Z",
		preview: "",
	};

	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	let listBodies: { active: unknown; archived: unknown };
	const realFetch = globalThis.fetch;

	const installGlobal = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	beforeEach(() => {
		win = new Window();
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		installed = [];
		listBodies = {
			active: { notes: [SUMMARY], truncated: false },
			archived: { notes: [], truncated: false },
		};
		for (const [name, value] of [
			["window", win],
			["document", win.document],
			["navigator", win.navigator],
			["localStorage", win.localStorage],
			["Event", win.Event],
			["CustomEvent", win.CustomEvent],
			["getComputedStyle", win.getComputedStyle],
		] as const) {
			installGlobal(name, value);
		}
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/app/notes" || url.startsWith("/api/app/notes?")) {
				const u = new URL(url, "http://localhost");
				return Promise.resolve(
					jsonResponse(
						u.searchParams.get("archived") === "1" ? listBodies.archived : listBodies.active,
					),
				);
			}
			return Promise.resolve(jsonResponse({ error: "unstubbed fetch" }, 404));
		}) as typeof fetch;
	});

	afterEach(async () => {
		if (root !== null) {
			await act(async () => {
				root?.unmount();
			});
			root = null;
		}
		await win.happyDOM.close();
		globalThis.fetch = realFetch;
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		for (const name of installed) Reflect.deleteProperty(globalThis, name);
		installed = [];
	});

	const settle = async () => {
		await act(async () => {
			await new Promise((r) => setTimeout(r, 30));
		});
	};
	const waitFor = async (pred: () => boolean, label: string) => {
		for (let i = 0; i < 100; i++) {
			if (pred()) return;
			await settle();
		}
		throw new Error(`timed out waiting for ${label}`);
	};
	const mount = async (el: ReactNode) => {
		root = createRoot(container);
		await act(async () => {
			root?.render(el);
		});
		// The list's own fetch is debounced — a rendered row is the
		// loaded marker, not the filters that paint immediately.
		await waitFor(() => container.querySelector(".idx") !== null, "a rendered note row");
	};

	test("a capped list says so — active and archived carry their own notice", async () => {
		listBodies = {
			active: { notes: [SUMMARY], truncated: true },
			archived: {
				notes: [{ ...SUMMARY, id: "n2", title: "gone", archivedAt: "2026-10-11T00:00:00Z" }],
				truncated: true,
			},
		};
		await mount(<NotesIndex token={null} projects={[]} onOpen={() => {}} />);
		expect(container.textContent).toContain(
			"Showing the first 1 matching notes — narrow the search or pick a project",
		);
		expect(container.textContent).toContain(
			"Showing the first 1 archived notes — narrow the search or pick a project",
		);
		// The collapsed shelf flags it in the count too.
		expect(container.querySelector("summary")?.textContent).toBe("Archived notes (1+)");
	});

	test("a complete list carries no notice and a plain archived count", async () => {
		listBodies = {
			active: { notes: [SUMMARY], truncated: false },
			archived: {
				notes: [{ ...SUMMARY, id: "n2", title: "gone", archivedAt: "2026-10-11T00:00:00Z" }],
				truncated: false,
			},
		};
		await mount(<NotesIndex token={null} projects={[]} onOpen={() => {}} />);
		expect(container.textContent).not.toContain("Showing the first");
		expect(container.querySelector("summary")?.textContent).toBe("Archived notes (1)");
	});
});
