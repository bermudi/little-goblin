// The note editor's autosave loop under happy-dom (design/projects.md
// → Notes): the baseline is the serializer's own output, so loading a
// body Milkdown normalizes (`-` → `*`) must not autosave a rewrite the
// operator never typed; a save requested mid-flight reruns on settle;
// pagehide flushes the pending save through fetch keepalive.
//
// Document edits go through the real editor via handle.editor() —
// Milkdown's listener plugin debounces doc updates ~200ms, so tests
// wait LISTENER_MS after each edit before expecting the debounce
// (saveDelayMs) to have started.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { getMarkdown, replaceAll } from "@milkdown/kit/utils";
import type { AppNote } from "../../src/http/app-wire.ts";
import NoteEditor, { type NoteEditorHandle } from "./NoteEditor.tsx";

const DELAY = 20; // ms — the component's save debounce, shortened
const LISTENER_MS = 260; // Milkdown's own 200ms update debounce + margin

const note: AppNote = {
	id: "n-1",
	projectId: null,
	title: "t",
	body: "- a\n- b",
	rev: 1,
	lastSource: "app",
	pinnedAt: null,
	archivedAt: null,
	createdAt: "x",
	updatedAt: "x",
};

interface PatchCall {
	body: { body?: string; title?: string; source?: string };
	init: RequestInit;
}
const patches: PatchCall[] = [];
// The generation POST — recorded, answerable, holdable.
interface RewriteCall {
	body: { selection: string; instruction: string };
	signal: AbortSignal | null;
}
const rewrites: RewriteCall[] = [];
const ops: string[] = []; // request order: "patch" | "rewrite"
let rewriteText = "**rewritten**";
let holdRewriteFlag = false;
let pendingRewriteRelease: (() => void) | null = null;
let failRewriteOnce: { status: number; body: unknown } | null = null;

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
let installed: string[] = [];
let holdPatchFlag = false;
let pendingRelease: (() => void) | null = null;
// A one-shot 409: the next PATCH answers {error, note} like the real
// conflict path, once.
let conflictOnce: AppNote | null = null;
// One-shot failures: a response-level refusal (4xx/5xx) or a thrown
// TypeError mimicking a dropped network.
let failPatchOnce: { status: number; body: unknown } | null = null;
let rejectPatchOnce = false;
const realFetch = globalThis.fetch;

// Hold the next PATCH's response open so a test can edit mid-flight.
const holdPatch = () => {
	holdPatchFlag = true;
};
const releasePatch = () => {
	pendingRelease?.();
	pendingRelease = null;
};
const holdRewrite = () => {
	holdRewriteFlag = true;
};
const releaseRewrite = () => {
	pendingRewriteRelease?.();
	pendingRewriteRelease = null;
};
const theirs = (over: Partial<AppNote> = {}): AppNote => ({
	...note,
	rev: 5,
	body: "theirs body",
	title: "theirs title",
	updatedAt: "y",
	...over,
});

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
	holdPatchFlag = false;
	pendingRelease = null;
	conflictOnce = null;
	failPatchOnce = null;
	rejectPatchOnce = false;
	rewrites.length = 0;
	ops.length = 0;
	rewriteText = "**rewritten**";
	holdRewriteFlag = false;
	pendingRewriteRelease = null;
	failRewriteOnce = null;
	savedNotes.length = 0;
	conflicts.length = 0;
	busies.length = 0;
	applyings.length = 0;
	// happy-dom's realm, same seam as the other mounted tests plus the
	// ProseMirror-facing globals noteMarkdown.test.ts installs.
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
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		if (url.endsWith("/rewrite") && method === "POST") {
			const body = JSON.parse(init?.body as string) as RewriteCall["body"];
			rewrites.push({ body, signal: init?.signal ?? null });
			ops.push("rewrite");
			if (failRewriteOnce !== null) {
				const f = failRewriteOnce;
				failRewriteOnce = null;
				return Promise.resolve(jsonResponse(f.body, f.status));
			}
			if (holdRewriteFlag) {
				holdRewriteFlag = false;
				return new Promise<Response>((res) => {
					pendingRewriteRelease = () => res(jsonResponse({ replacement: rewriteText }));
				});
			}
			return Promise.resolve(jsonResponse({ replacement: rewriteText }));
		}
		if (url.startsWith("/api/app/notes/") && method === "PATCH") {
			const body = JSON.parse(init?.body as string) as PatchCall["body"];
			patches.push({ body, init: init ?? {} });
			ops.push("patch");
			if (conflictOnce !== null) {
				const c = conflictOnce;
				conflictOnce = null;
				return Promise.resolve(jsonResponse({ error: "conflict", note: c }, 409));
			}
			if (failPatchOnce !== null) {
				const f = failPatchOnce;
				failPatchOnce = null;
				return Promise.resolve(jsonResponse(f.body, f.status));
			}
			if (rejectPatchOnce) {
				rejectPatchOnce = false;
				return Promise.reject(new TypeError("fetch failed"));
			}
			const next: AppNote = { ...note, rev: note.rev + patches.length, ...body };
			if (holdPatchFlag) {
				holdPatchFlag = false;
				return new Promise<Response>((res) => {
					// The server's answer is decided when the response
					// lands, not when the request left — a held PATCH can
					// still come back 409.
					pendingRelease = () => {
						if (conflictOnce !== null) {
							const c = conflictOnce;
							conflictOnce = null;
							res(jsonResponse({ error: "conflict", note: c }, 409));
						} else {
							res(jsonResponse(next));
						}
					};
				});
			}
			return Promise.resolve(jsonResponse(next));
		}
		return Promise.resolve(jsonResponse({ error: `unfaked ${method} ${url}` }, 500));
	}) as typeof fetch;
});

afterEach(async () => {
	releasePatch();
	releaseRewrite();
	if (root !== null) {
		await act(async () => root!.unmount());
		root = null;
	}
	patches.length = 0;
	await win.happyDOM.close();
	for (const name of installed) Reflect.deleteProperty(globalThis, name);
	installed = [];
	globalThis.fetch = realFetch;
});

const tick = (ms: number) => act(async () => await new Promise((r) => setTimeout(r, ms)));
const settle = () => tick(DELAY * 4); // mount/create + component debounce
const notice = () => tick(LISTENER_MS); // Milkdown's update debounce

const savedNotes: AppNote[] = [];
const conflicts: AppNote[] = [];
const busies: boolean[] = [];
const applyings: boolean[] = [];

async function mount(
	body = note.body,
	saveDelayMs = DELAY,
	noteOver: Partial<AppNote> = {},
): Promise<{ current: NoteEditorHandle | null }> {
	const ref = createRef<NoteEditorHandle>();
	await act(async () =>
		root!.render(
			<NoteEditor
				ref={ref}
				token={null}
				noteId={note.id}
				initialNote={{ ...note, ...noteOver, body }}
				onSaved={(n) => savedNotes.push(n)}
				onConflict={(n) => conflicts.push(n)}
				onRewriteBusy={(b) => busies.push(b)}
				onRewriteApplying={(a) => applyings.push(a)}
				saveDelayMs={saveDelayMs}
			/>,
		),
	);
	return ref;
}

async function edit(ref: { current: NoteEditorHandle | null }, md: string): Promise<void> {
	await act(async () => ref.current?.editor()?.action(replaceAll(md)));
}

// A real PM TextSelection dispatched through the view — the same
// shape keyboard and mouse selections produce through selectionUpdated.
async function select(
	ref: { current: NoteEditorHandle | null },
	from: number,
	to: number,
): Promise<void> {
	await act(async () => {
		ref.current?.editor()?.action((ctx) => {
			const view = ctx.get(editorViewCtx);
			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
		});
	});
	await tick(0);
}

const toolbarBtn = (): HTMLButtonElement | null =>
	container.querySelector<HTMLButtonElement>(".note-editor-bar button");

// The durable draft record for this note — the happy-dom localStorage
// installed as the global is the module's store.
const DRAFT_KEY = `goblin.note-draft.v1:${encodeURIComponent(note.id)}`;
interface StoredDraft {
	version: 1;
	noteId: string;
	baseRev: number;
	baseBody: string;
	body: string;
}
const storedDraft = (): StoredDraft | null => {
	const raw = (globalThis.localStorage as Storage | undefined)?.getItem(DRAFT_KEY) ?? null;
	return raw === null ? null : (JSON.parse(raw) as StoredDraft);
};
const seedDraft = (over: Partial<StoredDraft> = {}): string => {
	const rec: StoredDraft = {
		version: 1,
		noteId: note.id,
		baseRev: note.rev,
		baseBody: note.body,
		body: "seeded work",
		...over,
	};
	const raw = JSON.stringify(rec);
	(globalThis.localStorage as Storage).setItem(DRAFT_KEY, raw);
	return raw;
};
const panelText = (sel: string): string | null => container.querySelector(sel)?.textContent ?? null;
const clickBtn = async (text: string): Promise<void> => {
	const btn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(b) => b.textContent === text,
	);
	expect(btn).toBeDefined();
	await act(async () => btn!.click());
};
async function typeInstruction(text: string): Promise<void> {
	const ta = container.querySelector<HTMLTextAreaElement>(".note-rewrite-field textarea")!;
	await act(async () => {
		// Focus + keyup too — React's text-input fallback needs it in
		// this environment (MemoryView.test's ruling).
		ta.focus();
		Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(
			ta,
			text,
		);
		ta.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
		ta.dispatchEvent(
			new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
		);
	});
}

// The full open path: select in the doc, open the toolbar flow, wait
// out the (no-op or real) pre-flush into the instruction phase.
async function openFlow(
	ref: { current: NoteEditorHandle | null },
	from: number,
	to: number,
	instruction = "tighten it",
): Promise<void> {
	await select(ref, from, to);
	await clickBtn("Rewrite selection");
	await settle();
	await typeInstruction(instruction);
}

describe("NoteEditor save loop", () => {
	test("mounting a body Milkdown normalizes autosaves nothing", async () => {
		root = createRoot(container);
		await mount();
		await notice();
		await settle();
		expect(patches).toHaveLength(0);
	});

	test("reload() rebases on the serialized form — still nothing to save", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		await act(async () => ref.current?.reload({ ...note, body: "- x\n- y", rev: 7 }));
		await notice();
		await settle();
		expect(patches).toHaveLength(0);
		expect(ref.current?.dirty()).toBe(false);
	});

	test("a save requested mid-flight runs once the in-flight one settles", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		holdPatch();
		await edit(ref, "v2");
		await notice(); // markdownUpdated → debounce → PATCH #1 leaves, held
		await settle();
		expect(patches).toHaveLength(1);
		await edit(ref, "v3"); // dirty again while #1 is in flight
		await notice();
		releasePatch();
		await settle();
		expect(patches.length).toBeGreaterThanOrEqual(2);
		expect(patches[1]!.body.body).toContain("v3");
	});

	test("pagehide flushes the pending save through fetch keepalive", async () => {
		root = createRoot(container);
		// A long save debounce keeps the edit pending until the flush.
		const ref = await mount(note.body, 60_000);
		await notice();
		await edit(ref, "leaving now");
		await notice();
		await act(async () => win.dispatchEvent(new win.Event("pagehide")));
		await tick(0);
		expect(patches).toHaveLength(1);
		expect(patches[0]!.init.keepalive).toBe(true);
	});

	test("an edit flushed by unmount PATCHes without waiting for the listener", async () => {
		root = createRoot(container);
		const ref = await mount(note.body, 60_000);
		await notice();
		await edit(ref, "typed then left");
		// No notice() — the listener hasn't seen the edit yet; the
		// cleanup drain serializes synchronously.
		await act(async () => root!.unmount());
		await tick(DELAY * 5);
		expect(patches).toHaveLength(1);
		expect(patches[0]!.body.body).toContain("typed then left");
	});

	test("an edit mid-flight still lands at the new rev after unmount", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		holdPatch();
		await edit(ref, "v2");
		await notice();
		await settle();
		expect(patches).toHaveLength(1);
		// Dirty again while PATCH #1 is held, then leave.
		await edit(ref, "v3");
		await act(async () => root!.unmount());
		releasePatch();
		await tick(DELAY * 10);
		expect(patches).toHaveLength(2);
		expect(patches[1]!.body.body).toContain("v3");
		// The drain re-saved at the rev PATCH #1 returned (1 + 1).
		const headers = patches[1]!.init.headers as Record<string, string>;
		expect(headers["if-match"]).toBe('"2"');
	});

	test("flushAndWait on a clean buffer resolves true without a PATCH", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		await settle();
		const verdict = { ok: null as boolean | null };
		await act(async () => {
			verdict.ok = await ref.current!.flushAndWait();
		});
		expect(verdict.ok).toBe(true);
		expect(patches).toHaveLength(0);
	});

	test("flushAndWait rides the held PATCH, then writes the mid-flight edit at the landed rev", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		holdPatch();
		await edit(ref, "v2");
		await notice();
		await settle();
		expect(patches).toHaveLength(1);
		const verdict = { ok: null as boolean | null };
		const flush = ref.current!.flushAndWait().then((ok) => {
			verdict.ok = ok;
		});
		await edit(ref, "v3");
		await tick(0);
		expect(verdict.ok).toBeNull();
		releasePatch();
		await act(async () => {
			await flush;
		});
		await settle();
		expect(verdict.ok).toBe(true);
		expect(patches).toHaveLength(2);
		expect(patches[1]!.body.body).toContain("v3");
		const headers = patches[1]!.init.headers as Record<string, string>;
		expect(headers["if-match"]).toBe('"2"');
	});

	test("flushAndWait resolves false on a dropped network instead of retry-looping", async () => {
		root = createRoot(container);
		const ref = await mount(note.body, 60_000);
		await notice();
		rejectPatchOnce = true;
		await edit(ref, "v2");
		await notice();
		const verdict = { ok: null as boolean | null };
		await act(async () => {
			verdict.ok = await ref.current!.flushAndWait();
		});
		expect(verdict.ok).toBe(false);
		expect(patches).toHaveLength(1);
		expect(ref.current?.dirty()).toBe(true);
	});

	test("flushAndWait rejects on a serializer fault — nothing swallowed, buffer intact", async () => {
		root = createRoot(container);
		const ref = await mount(note.body, 60_000);
		await notice();
		await edit(ref, "v2");
		await notice();
		const ed = ref.current!.editor()!;
		const origAction = ed.action.bind(ed);
		let armed = true;
		(ed as { action: unknown }).action = (ctx: (c: unknown) => unknown) => {
			if (armed) {
				armed = false;
				throw new Error("injected serializer failure");
			}
			return origAction(ctx);
		};
		await act(async () => {
			await expect(ref.current!.flushAndWait()).rejects.toThrow("injected serializer failure");
		});
		expect(patches).toHaveLength(0);
		expect(ed.action(getMarkdown())).toContain("v2");
		const verdict = { ok: null as boolean | null };
		await act(async () => {
			verdict.ok = await ref.current!.flushAndWait();
		});
		expect(verdict.ok).toBe(true);
		expect(patches).toHaveLength(1);
		expect(patches[0]!.body.body).toContain("v2");
	});

	test("flushAndWait resolves false under a conflict and never PATCHes past the bar", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		conflictOnce = theirs();
		await edit(ref, "v2");
		await notice();
		await settle();
		expect(patches).toHaveLength(1);
		const verdict = { ok: null as boolean | null };
		await act(async () => {
			verdict.ok = await ref.current!.flushAndWait();
		});
		expect(verdict.ok).toBe(false);
		expect(patches).toHaveLength(1);
	});

	test("flushAndWait outlives unmount only as a false verdict — no post-unmount writes", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		holdPatch();
		await edit(ref, "v2");
		await notice();
		await settle();
		expect(patches).toHaveLength(1);
		const verdict = { ok: null as boolean | null };
		const flush = ref.current!.flushAndWait().then((ok) => {
			verdict.ok = ok;
		});
		await act(async () => root!.unmount());
		root = null;
		releasePatch();
		await act(async () => {
			await flush;
		});
		expect(verdict.ok).toBe(false);
	});

	test("a conflict blocks automatic saves and flush until resolve", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		conflictOnce = theirs();
		await edit(ref, "mine one");
		await notice();
		await settle();
		expect(patches).toHaveLength(1);
		expect(conflicts).toHaveLength(1);
		expect(container.querySelector(".note-save-status")!.textContent).toBe("Conflict");
		// More typing, the debounce, and an explicit flush — all blocked.
		await edit(ref, "mine two");
		await notice();
		await act(async () => ref.current?.flush());
		await settle();
		expect(patches).toHaveLength(1);
		expect(ref.current?.dirty()).toBe(true);
		// Keep mine: one forced write at theirs.rev clears the block.
		await act(async () => ref.current?.resolve("mine", conflicts[0]!));
		await settle();
		expect(patches).toHaveLength(2);
		const forced = patches[1]!;
		expect(forced.body.body).toContain("mine two");
		expect((forced.init.headers as Record<string, string>)["if-match"]).toBe('"5"');
		expect(savedNotes).toHaveLength(1);
		expect(container.querySelector(".note-save-status")!.textContent).toBe("Saved");
	});

	test("resolve 'mine' writes title and body at the conflicting rev", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		// A title conflict with an untouched body — the forced write
		// must not short-circuit as "already saved".
		const other = theirs();
		await act(async () => ref.current?.conflict(other));
		expect(conflicts).toHaveLength(1);
		await act(async () => ref.current?.resolve("mine", other, "My Title"));
		await settle();
		expect(patches).toHaveLength(1);
		expect(patches[0]!.body.title).toBe("My Title");
		// The body went out too — serialized (`-` normalizes to `*`),
		// even though it equals the baseline.
		expect(patches[0]!.body.body).toBe("* a\n* b\n");
	});

	test("adoptRev refuses a moved server body while dirty, adopts while clean", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		// Dirty: an agent write between our ack and this response must
		// conflict, not silently rev-match an overwrite.
		await edit(ref, "local edits");
		await act(async () => ref.current?.adoptRev(theirs({ body: "agent wrote", rev: 4 })));
		expect(conflicts).toHaveLength(1);
		expect(ref.current?.dirty()).toBe(true);
		// Clean: the moved body is adopted wholesale.
		conflicts.length = 0;
		await act(async () => ref.current?.reload(note));
		await act(async () => ref.current?.adoptRev(theirs({ body: "agent wrote", rev: 4 })));
		expect(conflicts).toHaveLength(0);
		expect(ref.current?.dirty()).toBe(false);
		expect(ref.current?.editor()?.action(getMarkdown())).toContain("agent wrote");
	});

	test("adoptRev never moves the rev backwards", async () => {
		root = createRoot(container);
		const ref = await mount(note.body, 60_000);
		await notice();
		// Same body, higher rev — advances.
		await act(async () => ref.current?.adoptRev({ ...note, rev: 9 }));
		// Same body, older rev — ignored.
		await act(async () => ref.current?.adoptRev({ ...note, rev: 2 }));
		await edit(ref, "x");
		await act(async () => ref.current?.flush());
		await settle();
		expect(patches).toHaveLength(1);
		expect((patches[0]!.init.headers as Record<string, string>)["if-match"]).toBe('"9"');
	});

	test("a stale different-body response leaves doc and rev untouched", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		await edit(ref, "local v2");
		await notice();
		await settle();
		expect(patches).toHaveLength(1); // saved → rev 2, body "local v2"
		// A delayed flag response from before the save carries the old
		// rev AND the old body — neither may move.
		await act(async () =>
			ref.current?.adoptRev({ ...note, rev: 1, body: "stale", updatedAt: "z" }),
		);
		expect(ref.current?.dirty()).toBe(false);
		expect(ref.current?.editor()?.action(getMarkdown())).toContain("local v2");
		await edit(ref, "v3");
		await notice();
		await settle();
		expect(patches).toHaveLength(2);
		// The write rev never rolled back — If-Match is still the ack'd 2.
		const headers = patches[1]!.init.headers as Record<string, string>;
		expect(headers["if-match"]).toBe('"2"');
		expect(patches[1]!.body.body).toContain("v3");
	});

	test("a debounce armed mid-flight dies with the in-flight 409", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		holdPatch();
		await edit(ref, "v2");
		await notice();
		await settle();
		expect(patches).toHaveLength(1); // PATCH #1 held
		await edit(ref, "v3"); // arms the debounce timer
		await notice();
		conflictOnce = theirs();
		releasePatch();
		await tick(DELAY * 4); // the armed timer fires into the 409 block
		expect(patches).toHaveLength(1);
		expect(container.querySelector(".note-save-status")!.textContent).toBe("Conflict");
		// Undo back to the baseline — still Conflict, not Saved.
		await edit(ref, note.body);
		await notice();
		expect(ref.current?.dirty()).toBe(false);
		expect(container.querySelector(".note-save-status")!.textContent).toBe("Conflict");
	});

	test("a delayed success can't clear a newer observed conflict", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		holdPatch();
		await edit(ref, "v2");
		await notice();
		await settle();
		expect(patches).toHaveLength(1); // PATCH #1 held — will return rev 2
		// Focus refresh observed an agent's rev 3 before the ack landed.
		await act(async () => ref.current?.conflict(theirs({ rev: 3 })));
		releasePatch();
		await tick(DELAY * 4);
		// The write landed (ack delivered) but the block stands.
		expect(savedNotes).toHaveLength(1);
		expect(container.querySelector(".note-save-status")!.textContent).toBe("Conflict");
		await edit(ref, "v3");
		await notice();
		await settle();
		expect(patches).toHaveLength(1); // no followup overwrite
	});

	test("a permanent refusal stops the loop with a visible error", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		failPatchOnce = { status: 422, body: { error: "note is archived" } };
		await edit(ref, "v2");
		await notice();
		await settle();
		expect(patches).toHaveLength(1);
		expect(container.querySelector(".note-save-status")!.textContent).toBe(
			"Save failed: note is archived",
		);
		await tick(DELAY * 6); // exactly one attempt — no retry storm
		expect(patches).toHaveLength(1);
	});

	test("a network failure retries on the debounce", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		rejectPatchOnce = true;
		await edit(ref, "v2");
		await notice();
		await settle();
		// The TypeError took the offline path — settle rescheduled and
		// the retry landed inside the debounce window.
		expect(patches).toHaveLength(2);
		expect(container.querySelector(".note-save-status")!.textContent).toBe("Saved");
	});
});

// Selection rewrite (design/projects.md → AI rewrite): a real PM
// TextSelection drives the toolbar; generation is preview-only until
// Apply, whose PATCH rides the same If-Match guard with source
// "rewrite". Positions below are doc positions — paragraph text
// starts at 1.
describe("NoteEditor selection rewrite", () => {
	test("a real TextSelection enables the toolbar and captures the range", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		expect(toolbarBtn()!.disabled).toBe(true);
		await select(ref, 7, 11); // "beta"
		expect(toolbarBtn()!.disabled).toBe(false);
		await clickBtn("Rewrite selection");
		await settle();
		expect(panelText(".note-rewrite-sel")).toBe("beta\n");
		expect(busies).toEqual([true]);
		// The editor is locked — the doc can't change under the flow.
		let editable: boolean | undefined;
		await act(async () => {
			ref.current?.editor()?.action((ctx) => {
				const view = ctx.get(editorViewCtx);
				editable = view.props.editable?.(view.state);
			});
		});
		expect(editable).toBe(false);
		// Cancel releases the page and the editor.
		await clickBtn("Cancel");
		await settle();
		expect(busies).toEqual([true, false]);
		await act(async () => {
			ref.current?.editor()?.action((ctx) => {
				const view = ctx.get(editorViewCtx);
				editable = view.props.editable?.(view.state);
			});
		});
		expect(editable).toBe(true);
	});

	test("the captured markdown keeps emphasis and inline code", async () => {
		root = createRoot(container);
		const ref = await mount("pre *em* and `cd` post");
		await notice();
		// Parsed text: "pre em and cd post" — em at 5..7, cd at 12..14.
		await openFlow(ref, 5, 7);
		expect(panelText(".note-rewrite-sel")).toBe("*em*\n");
		await clickBtn("Cancel");
		await settle();
		await openFlow(ref, 12, 14);
		expect(panelText(".note-rewrite-sel")).toBe("`cd`\n");
	});

	test("a pending edit lands before the generation leaves", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		// Dirty, pre-listener — the flow flushes synchronously.
		await edit(ref, "alpha beta gamma — draft");
		await openFlow(ref, 7, 11);
		await clickBtn("Generate rewrite");
		await settle();
		expect(ops).toEqual(["patch", "rewrite"]);
		expect(patches[0]!.body.body).toContain("draft");
		expect((patches[0]!.init.headers as Record<string, string>)["if-match"]).toBe('"1"');
		expect(rewrites[0]!.body).toEqual({ selection: "beta\n", instruction: "tighten it" });
	});

	test("preview then discard writes nothing and leaves the doc alone", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		rewriteText = "delta";
		await openFlow(ref, 7, 11);
		await clickBtn("Generate rewrite");
		await settle();
		expect(panelText(".note-rewrite-preview")).toBe("delta");
		await clickBtn("Discard");
		await settle();
		expect(container.querySelector(".note-rewrite")).toBeNull();
		expect(patches).toHaveLength(0); // clean doc — no preflush either
		expect(ref.current?.editor()?.action(getMarkdown())).toContain("beta");
		expect(busies).toEqual([true, false]);
	});

	test("apply rewrites only the selected span as source 'rewrite'", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		rewriteText = "delta";
		await openFlow(ref, 7, 11);
		await clickBtn("Generate rewrite");
		await settle();
		await clickBtn("Apply rewrite");
		await settle();
		expect(patches).toHaveLength(1);
		expect(patches[0]!.body.source).toBe("rewrite");
		expect((patches[0]!.init.headers as Record<string, string>)["if-match"]).toBe('"1"');
		// Surrounding text survives; the span is replaced.
		expect(patches[0]!.body.body).toBe("alpha delta gamma\n");
		await notice();
		await settle();
		expect(ref.current?.editor()?.action(getMarkdown())).toBe("alpha delta gamma\n");
		expect(savedNotes).toHaveLength(1);
		expect(savedNotes[0]!.body).toBe("alpha delta gamma\n");
		// The reload after apply normalized nothing new — no followup
		// 'app' PATCH.
		expect(patches).toHaveLength(1);
		expect(busies).toEqual([true, false]);
	});

	test("the live doc stays put until the held apply PATCH lands", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		rewriteText = "delta";
		await openFlow(ref, 7, 11);
		await clickBtn("Generate rewrite");
		await settle();
		holdPatch();
		await clickBtn("Apply rewrite");
		await settle();
		expect(patches).toHaveLength(1); // sent, held — not applied yet
		expect(ref.current?.editor()?.action(getMarkdown())).toContain("beta");
		releasePatch();
		await settle();
		expect(ref.current?.editor()?.action(getMarkdown())).toContain("delta");
	});

	test("a generation refusal surfaces inline and the flow can retry", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		failRewriteOnce = { status: 429, body: { error: "rate limited" } };
		await openFlow(ref, 7, 11);
		await clickBtn("Generate rewrite");
		await settle();
		expect(panelText(".note-rewrite-error")).toContain("Couldn't generate");
		expect(container.querySelector(".note-rewrite")).not.toBeNull();
		expect(patches).toHaveLength(0);
		// Retry against the same capture succeeds.
		await clickBtn("Generate rewrite");
		await settle();
		expect(rewrites).toHaveLength(2);
		expect(panelText(".note-rewrite-preview")).toBe("**rewritten**");
	});

	test("an apply conflict keeps the preview and the local doc", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		await openFlow(ref, 7, 11);
		await clickBtn("Generate rewrite");
		await settle();
		conflictOnce = theirs();
		await clickBtn("Apply rewrite");
		await settle();
		expect(conflicts).toHaveLength(1);
		expect(panelText(".note-rewrite-error")).toContain("newer version");
		expect(panelText(".note-rewrite-preview")).toBe("**rewritten**");
		expect(container.querySelector(".note-save-status")!.textContent).toBe("Conflict");
		expect(ref.current?.editor()?.action(getMarkdown())).toContain("beta");
	});

	test("cancel aborts the request and ignores the late output", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		await openFlow(ref, 7, 11);
		holdRewrite();
		await clickBtn("Generate rewrite");
		await settle();
		expect(rewrites).toHaveLength(1);
		await clickBtn("Cancel");
		expect(rewrites[0]!.signal?.aborted).toBe(true);
		expect(container.querySelector(".note-rewrite")).toBeNull();
		// The response lands after the cancel — dropped, nothing applies.
		releaseRewrite();
		await settle();
		expect(patches).toHaveLength(0);
		expect(ref.current?.editor()?.action(getMarkdown())).toContain("beta");
	});

	test("a doc change after capture refuses the apply", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		await openFlow(ref, 7, 11);
		await clickBtn("Generate rewrite");
		await settle();
		// A programmatic edit (the lock gates input, not dispatch) —
		// the recorded offsets no longer describe this doc.
		await edit(ref, "something else entirely");
		await clickBtn("Apply rewrite");
		await settle();
		expect(panelText(".note-rewrite-error")).toContain("changed since this rewrite");
		expect(patches).toHaveLength(0);
	});

	test("a canceled preflush's late continuation can't touch a newer flow", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		await edit(ref, "alpha beta gamma — draft"); // dirty, pre-listener
		holdPatch();
		await select(ref, 7, 11); // "beta"
		await clickBtn("Rewrite selection");
		await settle();
		expect(patches).toHaveLength(1); // the flow-1 preflush PATCH, held
		// Cancel flow #1, open flow #2 on a different span — its
		// preflush waits on the same held write.
		await clickBtn("Cancel");
		await select(ref, 12, 17); // "gamma"
		await clickBtn("Rewrite selection");
		await tick(DELAY);
		releasePatch();
		await settle();
		// Flow #1's continuation was superseded — only flow #2's panel
		// survived, and it reached the instruction phase.
		expect(panelText(".note-rewrite-sel")).toBe("gamma\n");
		expect(
			container.querySelector<HTMLTextAreaElement>(".note-rewrite-field textarea")!.disabled,
		).toBe(false);
		expect(busies).toEqual([true, false, true]);
		expect(patches).toHaveLength(1); // the landed preflush — no extra writes
	});

	test("unmount during a held preflush fires no stale callbacks", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		await edit(ref, "alpha beta gamma — draft");
		holdPatch();
		await select(ref, 7, 11);
		await clickBtn("Rewrite selection");
		await settle();
		expect(patches).toHaveLength(1); // preflush PATCH held
		await act(async () => root!.unmount());
		releasePatch();
		await tick(DELAY * 10);
		// The busy release at unmount was the last page callback — the
		// late preflush continuation touched nothing.
		expect(busies).toEqual([true, false]);
		expect(applyings).toHaveLength(0);
		expect(savedNotes).toHaveLength(0);
		expect(conflicts).toHaveLength(0);
		expect(patches).toHaveLength(1);
	});

	test("a held apply can't adopt over a newer observed conflict", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		rewriteText = "delta";
		await openFlow(ref, 7, 11);
		await clickBtn("Generate rewrite");
		await settle();
		holdPatch();
		await clickBtn("Apply rewrite");
		await settle();
		expect(patches).toHaveLength(1); // apply PATCH held — will return rev 2
		// Focus refresh observed an agent's rev 3 before the ack landed.
		await act(async () => ref.current?.conflict(theirs({ rev: 3 })));
		releasePatch();
		await settle();
		// The ack is reported (the page's forward guard drops the
		// stale rev) but the doc and the standing conflict stay.
		expect(savedNotes).toHaveLength(1);
		expect(conflicts).toHaveLength(1);
		expect(ref.current?.editor()?.action(getMarkdown())).toContain("beta");
		expect(container.querySelector(".note-save-status")!.textContent).toBe("Conflict");
		expect(container.querySelector(".note-rewrite")).toBeNull();
		expect(applyings).toEqual([true, false]);
		await edit(ref, "v3");
		await notice();
		await settle();
		expect(patches).toHaveLength(1); // no app followup PATCH
	});

	test("a held apply keeps a moved doc behind the conflict bar", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		rewriteText = "delta";
		await openFlow(ref, 7, 11);
		await clickBtn("Generate rewrite");
		await settle();
		holdPatch();
		await clickBtn("Apply rewrite");
		await settle();
		// A programmatic dispatch while the apply was held — the
		// buffer is unsaved work, not something to reload over.
		await edit(ref, "operator typed over");
		releasePatch();
		await settle();
		expect(ref.current?.editor()?.action(getMarkdown())).toContain("operator typed over");
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]!.body).toContain("delta"); // the landed write is the truth
		expect(savedNotes).toHaveLength(1);
		expect(container.querySelector(".note-save-status")!.textContent).toBe("Conflict");
		expect(container.querySelector(".note-rewrite")).toBeNull();
		await settle();
		expect(patches).toHaveLength(1); // blocked — no app write racing it
	});

	test("Load theirs during a preview ends the flow and unlocks", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		await openFlow(ref, 7, 11);
		await clickBtn("Generate rewrite");
		await settle();
		conflictOnce = theirs();
		await clickBtn("Apply rewrite");
		await settle();
		expect(conflicts).toHaveLength(1);
		expect(panelText(".note-rewrite-preview")).toBe("**rewritten**");
		// The explicit resolution ends the flow BEFORE the reload.
		await act(async () => ref.current?.resolve("theirs", conflicts[0]!));
		await settle();
		expect(container.querySelector(".note-rewrite")).toBeNull();
		expect(ref.current?.editor()?.action(getMarkdown())).toContain("theirs body");
		expect(busies[busies.length - 1]).toBe(false);
		let editable: boolean | undefined;
		await act(async () => {
			ref.current?.editor()?.action((ctx) => {
				const view = ctx.get(editorViewCtx);
				editable = view.props.editable?.(view.state);
			});
		});
		expect(editable).toBe(true);
	});

	test("Keep mine after an apply 409 writes the buffer, not the preview", async () => {
		root = createRoot(container);
		const ref = await mount("alpha beta gamma");
		await notice();
		await openFlow(ref, 7, 11);
		await clickBtn("Generate rewrite");
		await settle();
		conflictOnce = theirs();
		await clickBtn("Apply rewrite");
		await settle();
		expect(conflicts).toHaveLength(1);
		// Keep mine ends the flow, then force-writes the LOCAL doc at
		// theirs.rev — the proposal never entered the live doc.
		await act(async () => ref.current?.resolve("mine", conflicts[0]!));
		await settle();
		expect(container.querySelector(".note-rewrite")).toBeNull();
		expect(patches).toHaveLength(2);
		const forced = patches[1]!;
		expect((forced.init.headers as Record<string, string>)["if-match"]).toBe('"5"');
		expect(forced.body.body).toContain("beta");
		expect(forced.body.body).not.toContain("rewritten");
		expect(savedNotes).toHaveLength(1);
	});
});

// Durable draft (design/projects.md → Notes): a synchronous plugin
// capture persists every doc change to same-origin storage, so a
// typed-then-gone body survives the listener window. The record's base
// decides the revisit: same base → guarded autosave, stale base → the
// buffer restores behind the conflict bar, and while a conflict stands
// captures keep the ORIGINAL base — a revisit can never silently
// rebase stale local text over the newer remote.
describe("NoteEditor durable draft", () => {
	test("pristine mount writes no draft and no autosave — normalization is not an edit", async () => {
		root = createRoot(container);
		await mount();
		await notice();
		await settle();
		expect(patches).toHaveLength(0);
		expect(storedDraft()).toBeNull();
	});

	test("a >80KiB edit pagehidden before the listener fires is stored whole — keepalive omitted, recover and land", async () => {
		root = createRoot(container);
		const ref = await mount(note.body, 60_000);
		await notice();
		const big = "x".repeat(90 * 1024);
		holdPatch(); // the pagehide PATCH is held — the draft is the net
		await edit(ref, big);
		// No notice() — the listener hasn't seen the edit; the plugin
		// captured it synchronously.
		await act(async () => win.dispatchEvent(new win.Event("pagehide")));
		await tick(0);
		const d = storedDraft();
		expect(d?.body).toContain(big);
		expect(d?.baseRev).toBe(note.rev);
		expect(d?.baseBody).toBe(note.body);
		expect(patches).toHaveLength(1);
		expect(patches[0]!.body.body).toContain(big);
		expect(patches[0]!.init.keepalive).not.toBe(true);
		// Unmount with the flight still held — the draft stands.
		await act(async () => root!.unmount());
		expect(storedDraft()?.body).toContain(big);
		// Remount on the same storage: the draft restores and the
		// guarded autosave lands, retiring the record.
		root = createRoot(container);
		const ref2 = await mount(note.body, DELAY);
		await notice();
		await settle();
		expect(patches.length).toBeGreaterThanOrEqual(2);
		expect(patches[patches.length - 1]!.body.body).toContain(big);
		expect(ref2.current?.editor()?.action(getMarkdown())).toContain(big);
		expect(storedDraft()).toBeNull();
	});

	test("a draft whose body already landed retires without autosaving", async () => {
		seedDraft({ body: note.body });
		root = createRoot(container);
		const ref = await mount();
		await notice();
		await settle();
		expect(patches).toHaveLength(0);
		expect(storedDraft()).toBeNull();
		expect(ref.current?.dirty()).toBe(false);
	});

	test("a stale-base draft restores behind the conflict bar; keep-mine writes at the current rev", async () => {
		seedDraft({ body: "mine local" });
		root = createRoot(container);
		const ref = await mount("server moved", DELAY, { rev: 2, body: "server moved" });
		await notice();
		await settle();
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]!.rev).toBe(2);
		expect(conflicts[0]!.body).toBe("server moved");
		expect(patches).toHaveLength(0); // no silent rebase, no write
		expect(container.querySelector(".note-save-status")!.textContent).toBe("Conflict");
		expect(ref.current?.editor()?.action(getMarkdown())).toContain("mine local");
		await act(async () => ref.current?.resolve("mine", conflicts[0]!));
		await settle();
		expect(patches).toHaveLength(1);
		expect((patches[0]!.init.headers as Record<string, string>)["if-match"]).toBe('"2"');
		expect(patches[0]!.body.body).toContain("mine local");
		expect(storedDraft()).toBeNull();
	});

	test("a stale-base draft resolving theirs clears only the local record", async () => {
		seedDraft({ body: "mine local" });
		root = createRoot(container);
		const ref = await mount("server moved", DELAY, { rev: 2, body: "server moved" });
		await notice();
		expect(conflicts).toHaveLength(1);
		await act(async () => ref.current?.resolve("theirs", conflicts[0]!));
		await settle();
		expect(ref.current?.editor()?.action(getMarkdown())).toContain("server moved");
		expect(storedDraft()).toBeNull();
	});

	test("an edit mid-flight leaves the newer snapshot after the old ack; the next ack clears exactly it", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		holdPatch();
		await edit(ref, "v2");
		await notice();
		await settle();
		expect(patches).toHaveLength(1); // held — ack pending
		await edit(ref, "v3");
		releasePatch();
		// Flush the old ack — but not the +DELAY save it re-arms — so
		// the draft still shows the newer body rebased onto the ack's rev.
		await tick(0);
		const d = storedDraft();
		expect(d?.body).toContain("v3");
		expect(d?.baseRev).toBe(2);
		await notice();
		await settle();
		expect(patches).toHaveLength(2);
		expect(patches[1]!.body.body).toContain("v3");
		expect((patches[1]!.init.headers as Record<string, string>)["if-match"]).toBe('"2"');
		expect(storedDraft()).toBeNull();
	});

	test("a storage denial shows a persistent alert and emits a diagnostic — the network save still lands", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		const errors: string[] = [];
		win.addEventListener("error", (e) => errors.push((e as unknown as ErrorEvent).message));
		const original = globalThis.localStorage as Storage;
		Reflect.set(globalThis, "localStorage", {
			getItem: original.getItem.bind(original),
			setItem: () => {
				throw new DOMException("quota exceeded", "QuotaExceededError");
			},
			removeItem: original.removeItem.bind(original),
		});
		try {
			await edit(ref, "v2");
			await tick(0);
			expect(container.querySelector('[role="alert"]')?.textContent).toContain(
				"Local draft could not be preserved",
			);
			expect(errors.some((m) => m.includes("draft"))).toBe(true);
			await notice();
			await settle();
			expect(patches).toHaveLength(1); // the save itself still landed
			expect(container.querySelector(".note-save-status")!.textContent).toBe("Saved");
		} finally {
			Reflect.set(globalThis, "localStorage", original);
		}
		// Storage healthy again — the next successful capture retires
		// the alert.
		await edit(ref, "v3");
		await tick(0);
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	test("a conflicted draft keeps its ORIGINAL base across edits and remounts — never a silent rebase", async () => {
		seedDraft({ baseRev: 1, baseBody: note.body, body: "local WIP" });
		root = createRoot(container);
		const ref = await mount("server moved", DELAY, { rev: 2, body: "server moved" });
		await notice();
		await settle();
		expect(conflicts).toHaveLength(1);
		expect(patches).toHaveLength(0);
		// A further local edit while the conflict stands must keep the
		// draft's ORIGINAL base — rebasing onto rev 2 would make a
		// revisit think the server never moved.
		await edit(ref, "more local work");
		await tick(0);
		expect(storedDraft()?.body).toContain("more local work");
		expect(storedDraft()?.baseRev).toBe(1);
		expect(storedDraft()?.baseBody).toBe(note.body);
		await act(async () => root!.unmount());
		expect(storedDraft()?.baseRev).toBe(1);
		// Remount against the same moved server: still conflicted,
		// still no write — only explicit resolution unlocks.
		root = createRoot(container);
		const ref2 = await mount("server moved", DELAY, { rev: 2, body: "server moved" });
		await notice();
		await settle();
		expect(conflicts).toHaveLength(2);
		expect(patches).toHaveLength(0);
		expect(storedDraft()?.baseRev).toBe(1);
		expect(storedDraft()?.baseBody).toBe(note.body);
		expect(ref2.current?.editor()?.action(getMarkdown())).toContain("more local work");
	});

	test("an old ack under a newer conflict keeps the local side recoverable — revisit restores it", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		holdPatch();
		await edit(ref, "v2");
		await notice();
		await settle();
		expect(patches).toHaveLength(1); // v2 PATCH held
		// The remote moved to rev3 while the PATCH hung — the bar stands.
		await act(async () => ref.current?.conflict(theirs({ rev: 3, body: "remote three" })));
		releasePatch(); // the old ack (rev2/body v2) lands UNDER it
		await tick(DELAY * 2);
		// The local body must stay a draft at its ORIGINAL base — a
		// baseline-equal clear would lose the conflict's local side.
		const d = storedDraft();
		expect(d?.body).toContain("v2");
		expect(d?.baseRev).toBe(1);
		expect(d?.baseBody).toBe(note.body);
		expect(patches).toHaveLength(1); // nothing automatic under the bar
		await act(async () => root!.unmount());
		expect(storedDraft()?.body).toContain("v2"); // unmount didn't strip it
		// Remount on the same moved server: local v2 restores behind
		// the bar, still with no write.
		root = createRoot(container);
		const ref2 = await mount("remote three", DELAY, { rev: 3, body: "remote three" });
		await notice();
		await settle();
		expect(conflicts[conflicts.length - 1]!.rev).toBe(3);
		expect(patches).toHaveLength(1);
		expect(ref2.current?.editor()?.action(getMarkdown())).toContain("v2");
	});

	test("a landed draft retires by its verbatim stored bytes — indented JSON still clears", async () => {
		// Pretty-printed and reordered: parse-equal to a written record
		// but not the compact bytes a re-serialization would produce.
		const raw = `{
  "body": ${JSON.stringify(note.body)},
  "version": 1,
  "noteId": "${note.id}",
  "baseBody": ${JSON.stringify(note.body)},
  "baseRev": ${note.rev}
}`;
		(globalThis.localStorage as Storage).setItem(DRAFT_KEY, raw);
		root = createRoot(container);
		const ref = await mount();
		await notice();
		await settle();
		expect(patches).toHaveLength(0); // already landed — no autosave
		expect(storedDraft()).toBeNull(); // retired against the verbatim snapshot
		expect(ref.current?.dirty()).toBe(false);
	});

	test("a corrupt record warns with a fixed message — no stored payload reaches the alert or the diagnostic", async () => {
		const SENTINEL = "PRIVATE-BODY-zzz";
		const raw = `{"version":1,"noteId":"${note.id}","body":"${SENTINEL}`;
		(globalThis.localStorage as Storage).setItem(DRAFT_KEY, raw);
		const errors: string[] = [];
		win.addEventListener("error", (e) => errors.push((e as unknown as ErrorEvent).message));
		root = createRoot(container);
		const ref = await mount();
		await notice();
		const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
		expect(alert).toContain("Local draft could not be loaded");
		expect(alert).not.toContain(SENTINEL);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.every((m) => !m.includes(SENTINEL))).toBe(true);
		// The record stays put and the normal server doc still mounts.
		expect((globalThis.localStorage as Storage).getItem(DRAFT_KEY)).toBe(raw);
		expect(ref.current?.editor()?.action(getMarkdown())).toBe("* a\n* b\n");
	});

	test("an unreadable record is held until the operator discards it — edits and unload can't overwrite it", async () => {
		const raw = `{"version":1,"noteId":"${note.id}","body":"unreadable`;
		(globalThis.localStorage as Storage).setItem(DRAFT_KEY, raw);
		root = createRoot(container);
		const ref = await mount(note.body, 60_000); // autosave parked
		await notice();
		const alert = () => container.querySelector('[role="alert"]');
		expect(alert()?.textContent).toContain("Local draft could not be loaded");
		// The first edit's capture is refused — the bytes stay verbatim
		// instead of being replaced by the new buffer.
		await edit(ref, "typed over");
		await tick(0);
		expect((globalThis.localStorage as Storage).getItem(DRAFT_KEY)).toBe(raw);
		// The unload path can't clobber it either — the keepalive save
		// landed fine, but the preserved record still stands.
		await act(async () => win.dispatchEvent(new win.Event("pagehide")));
		await settle();
		expect(patches).toHaveLength(1);
		expect((globalThis.localStorage as Storage).getItem(DRAFT_KEY)).toBe(raw);
		expect(alert()).not.toBeNull();
		// The explicit discard frees the key; captures resume normally.
		await clickBtn("Discard draft");
		await tick(0);
		expect(alert()).toBeNull();
		expect(storedDraft()).toBeNull(); // clean doc post-save — nothing owed
		await edit(ref, "fresh work");
		await tick(0);
		expect(storedDraft()?.body).toContain("fresh work");
	});

	test("a detached ack never overwrites a newer component's draft", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		holdPatch();
		await edit(ref, "v2");
		await notice();
		await settle();
		expect(patches).toHaveLength(1); // v2 PATCH held
		await edit(ref, "v3");
		await act(async () => root!.unmount());
		expect(storedDraft()?.body).toContain("v3"); // unmount captured v3
		// A NEW component on the same storage recovers v3, then edits
		// v4 — the record is now owned by the newer editor.
		root = createRoot(container);
		const ref2 = await mount(note.body, 60_000);
		await notice();
		expect(ref2.current?.editor()?.action(getMarkdown())).toContain("v3");
		await edit(ref2, "v4");
		expect(storedDraft()?.body).toContain("v4");
		// Release the OLD v2 ack: its detached persist must not roll
		// the record back to v3. Its drain then fires a last write —
		// failed once so the loop ends.
		failPatchOnce = { status: 410, body: "gone" };
		releasePatch();
		await tick(DELAY * 4);
		expect(storedDraft()?.body).toContain("v4");
		expect(storedDraft()?.baseRev).toBe(1);
		expect(ref2.current?.editor()?.action(getMarkdown())).toContain("v4");
	});

	test("a mounted ack can't overwrite another owner's draft — every ack-side write compares", async () => {
		root = createRoot(container);
		const ref = await mount();
		await notice();
		holdPatch();
		await edit(ref, "v2");
		await notice();
		await settle();
		expect(patches).toHaveLength(1);
		await edit(ref, "v3");
		const bRaw = seedDraft({ body: "B newer work", baseRev: 9 });
		releasePatch();
		await tick(0);
		expect((globalThis.localStorage as Storage).getItem(DRAFT_KEY)).toBe(bRaw);
		await notice();
		await settle();
		expect(patches).toHaveLength(2);
		expect(patches[1]!.body.body).toContain("v3");
		expect((patches[1]!.init.headers as Record<string, string>)["if-match"]).toBe('"2"');
		expect((globalThis.localStorage as Storage).getItem(DRAFT_KEY)).toBe(bRaw);
		expect(ref.current?.editor()?.action(getMarkdown())).toContain("v3");
	});
});
