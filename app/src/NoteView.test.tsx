import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createRef, type ReactNode, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { Editor } from "@milkdown/kit/core";
import { replaceAll } from "@milkdown/kit/utils";
import { NoteView, NotesIndex } from "./NoteView.tsx";
import { rawNoteDraft, writeNoteDraft } from "./noteDraft.ts";
import type { AppNote, AppNoteSummary } from "../../src/http/app-wire.ts";

describe("main branch regressions", () => {
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
	const pendingChats: PromiseWithResolvers<void>[] = [];
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
		await act(async () => {
			for (const gate of pendingChats) gate.resolve();
			pendingChats.length = 0;
		});
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

	const mount = async (
		onChat: (n: AppNote) => Promise<void>,
		discardRef?: RefObject<(() => void) | null>,
	) => {
		root = createRoot(container);
		await act(async () => {
			root!.render(
				<NoteView
					token={null}
					noteId={note.id}
					projects={[]}
					onChat={onChat}
					onDeleted={() => {}}
					discardRef={discardRef}
				/>,
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

	test("discard retires the owned durable draft and a late ack or unload cannot revive it", async () => {
		const discard = createRef<(() => void) | null>();
		const gate = Promise.withResolvers<void>();
		pendingChats.push(gate);
		const pageFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			(input: RequestInfo | URL, init?: RequestInit) => {
				const reply = pageFetch(input, init);
				return init?.method === "PATCH" ? gate.promise.then(() => reply) : reply;
			},
			{ preconnect: realFetch.preconnect },
		);
		await mount(async () => {}, discard);
		await editBody("already sent");
		await act(async () => win.dispatchEvent(new win.Event("pagehide")));
		expect(patches).toHaveLength(1);
		await editBody("discard me");
		expect(rawNoteDraft(note.id)).toContain("discard me");
		await act(async () => discard.current?.());
		expect(rawNoteDraft(note.id)).toBeNull();
		await act(async () => win.dispatchEvent(new win.Event("pagehide")));
		expect(rawNoteDraft(note.id)).toBeNull();
		gate.resolve();
		await settle();
		expect(rawNoteDraft(note.id)).toBeNull();
		await act(async () => root!.unmount());
		root = null;
		await settle();
		expect(patches).toHaveLength(1);
		expect(rawNoteDraft(note.id)).toBeNull();
	});

	test("an edit and immediate retype of discarded text re-arms durable capture and save", async () => {
		const discard = createRef<(() => void) | null>();
		await mount(async () => {}, discard);
		await editBody("unsent text");
		await act(async () => discard.current?.());
		expect(rawNoteDraft(note.id)).toBeNull();
		await act(async () => {
			milkdowns[0]!.action(replaceAll("different text"));
			milkdowns[0]!.action(replaceAll("unsent text"));
		});
		expect(rawNoteDraft(note.id)).toContain("unsent text");
		await act(async () => win.dispatchEvent(new win.Event("pagehide")));
		expect(patches).toHaveLength(1);
		expect(patches[0]!.body.body).toContain("unsent text");
	});

	test("discard cannot clear a durable draft subsequently owned by another editor", async () => {
		const discard = createRef<(() => void) | null>();
		await mount(async () => {}, discard);
		await editBody("this editor's unsent text");
		const other = writeNoteDraft({
			version: 1,
			noteId: note.id,
			baseRev: note.rev,
			baseBody: note.body,
			body: "another tab",
		});
		await act(async () => discard.current?.());
		expect(rawNoteDraft(note.id)).toBe(other);
		await act(async () => win.dispatchEvent(new win.Event("pagehide")));
		expect(rawNoteDraft(note.id)).toBe(other);
	});

	describe("NoteView chat preparation", () => {
		test("a flushAndWait rejection surfaces inline — no mint, buffer stays, button frees", async () => {
			const chats: AppNote[] = [];
			await mount(async (n) => {
				chats.push(n);
			});
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
			await mount(async () => {
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

		test("chat stays busy through asynchronous minting and ignores duplicate clicks", async () => {
			const gate = Promise.withResolvers<void>();
			pendingChats.push(gate);
			let calls = 0;
			await mount(async () => {
				calls += 1;
				await gate.promise;
			});
			const btn = chatButton();
			await click(btn);
			expect(calls).toBe(1);
			expect(btn.disabled).toBe(true);
			await click(btn);
			expect(calls).toBe(1);
			expect(btn.disabled).toBe(true);

			await act(async () => gate.resolve());
			await settle();
			expect(btn.disabled).toBe(false);
		});

		test("an asynchronous mint failure surfaces inline and releases the busy guard", async () => {
			const gate = Promise.withResolvers<void>();
			pendingChats.push(gate);
			let calls = 0;
			await mount(async () => {
				calls += 1;
				if (calls === 1) await gate.promise;
			});
			const btn = chatButton();
			await click(btn);
			expect(btn.disabled).toBe(true);
			await act(async () => gate.reject(new Error("mint acknowledgement failed")));
			await settle();
			expect(alertText()).toContain(
				"Couldn't prepare this note for chat: mint acknowledgement failed",
			);
			expect(btn.disabled).toBe(false);
			await click(btn);
			expect(calls).toBe(2);
		});
	});
});

describe("quiet harbor regressions", () => {
	// The note page's own contracts: an archived note is read-only and
	// cannot start a note-bound chat (intake would 422 the empty
	// conversation's first message), and the leave guard's dirty report
	// reaches the App — an unsaved title/body or a standing conflict must
	// never die silently on navigation.

	const NOTE: AppNote = {
		id: "n1",
		projectId: null,
		title: "scratch",
		body: "draft body",
		rev: 3,
		stateRev: 3,
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
				["MutationObserver", win.MutationObserver],
				["Range", win.Range],
				["Node", win.Node],
				["HTMLElement", win.HTMLElement],
				["HTMLUnknownElement", win.HTMLUnknownElement],
				["requestAnimationFrame", win.requestAnimationFrame],
				["cancelAnimationFrame", win.cancelAnimationFrame],
			] as const) {
				installGlobal(name, value);
			}
			installGlobal("dispatchEvent", win.dispatchEvent.bind(win));
			installGlobal("addEventListener", win.addEventListener.bind(win));
			installGlobal("removeEventListener", win.removeEventListener.bind(win));
			Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
			globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url === `/api/app/notes/${note.id}` && init?.method === undefined) {
					return Promise.resolve(
						new Response(JSON.stringify(note), {
							headers: { "content-type": "application/json", etag: '"3"' },
						}),
					);
				}
				if (url === "/api/app/notes/versions")
					return Promise.resolve(jsonResponse({ versions: [] }));
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
			if (note.archivedAt === null)
				await waitFor(() => container.querySelector(".ProseMirror") !== null, "the loaded editor");
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
			stateRev: 1,
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
				["MutationObserver", win.MutationObserver],
				["Range", win.Range],
				["Node", win.Node],
				["HTMLElement", win.HTMLElement],
				["HTMLUnknownElement", win.HTMLUnknownElement],
				["requestAnimationFrame", win.requestAnimationFrame],
				["cancelAnimationFrame", win.cancelAnimationFrame],
			] as const) {
				installGlobal(name, value);
			}
			installGlobal("dispatchEvent", win.dispatchEvent.bind(win));
			installGlobal("addEventListener", win.addEventListener.bind(win));
			installGlobal("removeEventListener", win.removeEventListener.bind(win));
			Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
			globalThis.fetch = ((input: RequestInfo | URL) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
});
