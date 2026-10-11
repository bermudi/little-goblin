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
	body: { body?: string; title?: string };
	init: RequestInit;
}
const patches: PatchCall[] = [];

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
	savedNotes.length = 0;
	conflicts.length = 0;
	// happy-dom's realm, same seam as the other mounted tests plus the
	// ProseMirror-facing globals noteMarkdown.test.ts installs.
	for (const name of [
		"window",
		"document",
		"navigator",
		"localStorage",
		"Event",
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
		if (url.startsWith("/api/app/notes/") && method === "PATCH") {
			const body = JSON.parse(init?.body as string) as PatchCall["body"];
			patches.push({ body, init: init ?? {} });
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

async function mount(
	body = note.body,
	saveDelayMs = DELAY,
): Promise<{ current: NoteEditorHandle | null }> {
	const ref = createRef<NoteEditorHandle>();
	await act(async () =>
		root!.render(
			<NoteEditor
				ref={ref}
				token={null}
				noteId={note.id}
				initialBody={body}
				initialRev={note.rev}
				onSaved={(n) => savedNotes.push(n)}
				onConflict={(n) => conflicts.push(n)}
				saveDelayMs={saveDelayMs}
			/>,
		),
	);
	return ref;
}

async function edit(ref: { current: NoteEditorHandle | null }, md: string): Promise<void> {
	await act(async () => ref.current?.editor()?.action(replaceAll(md)));
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
