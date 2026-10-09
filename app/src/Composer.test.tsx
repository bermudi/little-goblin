// Interactive Composer behavior — the staged-upload lifecycle that
// static markup can't see. Mounted with happy-dom; the network edge
// (api.ts) is faked at globalThis.fetch, the only place uploads and
// config loads touch the wire. Pins issue #78: two staged files may
// share a filename (pasted images all arrive "image.png"), so upload
// completion must resolve by the entry's client key, never by name —
// otherwise the first completion captures every same-named row and the
// later one lands nowhere.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { UIMessage } from "ai";
import { Composer, type StagedUpload } from "./ChatView.tsx";

// The server's side of the contract: each upload lands on its own
// UUID-stemmed path (persistAttachment), so distinct uploads NEVER share
// a path even for identical filenames.
const refFor = (path: string) => ({
	path,
	mediaType: "image/jpeg",
	filename: "image.jpg",
	size: 3,
});

interface Deferred {
	promise: Promise<Response>;
	settle: { ok: (ref: { path: string }) => void; fail: () => void };
}

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Uploads resolve only when the test says so — that's what makes the
// completions "overlapping": both requests are in flight before either
// answers.
function deferredUpload(): Deferred {
	let ok!: (res: Response) => void;
	let fail!: (err: unknown) => void;
	const promise = new Promise<Response>((res, rej) => {
		ok = res;
		fail = rej;
	});
	return {
		promise,
		settle: {
			ok: (ref) => ok(jsonResponse({ ref }, 201)),
			fail: () => fail(new Error("upload boom")),
		},
	};
}

describe("Composer staged uploads (same filename, issue #78)", () => {
	let win: Window;
	// The container lives in the lib.dom type world (what react-dom's
	// types expect); the happy-dom realm supplies the runtime. One
	// deliberate cast at the seam — inside the test everything comes
	// from the same happy-dom window, so the values are coherent.
	let container: HTMLElement;
	let root: Root | null = null;
	let uploads: Deferred[] = [];
	const sent: UIMessage["parts"][] = [];
	// Globals the React tree expects; installed per test, removed after.
	let installed: string[] = [];
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
		uploads = [];
		sent.length = 0;
		installed = [];
		// React's client scheduler and event system need a coherent DOM
		// world; happy-dom's window provides it, Bun provides the rest
		// (crypto, Response, MessageChannel).
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			// The mount-time config load answers immediately; uploads queue
			// and settle only when the test says so — that is the overlap.
			if (url === "/api/app/attachments") {
				const d = deferredUpload();
				uploads.push(d);
				return d.promise;
			}
			return Promise.resolve(
				jsonResponse({
					model: "prov/model",
					thinking: "off",
					favorites: [],
					thinkingLevels: ["off"],
				}),
			);
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

	// The staged list is owned above the composer (#118); for direct
	// mounts this harness is that owner.
	function ComposerHarness({ onSend }: { onSend: (parts: UIMessage["parts"]) => void }) {
		const [staged, setStaged] = useState<StagedUpload[]>([]);
		return (
			<Composer token={null} busy={false} staged={staged} setStaged={setStaged} onSend={onSend} />
		);
	}

	const mount = () => {
		root = createRoot(container);
		act(() => {
			root?.render(<ComposerHarness onSend={(parts) => sent.push(parts)} />);
		});
	};

	// Stage files through the real hidden input — the one picking seam
	// every entry path (picker, paste, drop) funnels through.
	const stage = async (contents: string[]) => {
		const input = container.querySelector('input[type="file"]');
		expect(input).not.toBeNull();
		const files = contents.map((c) => new File([c], "image.jpg", { type: "image/jpeg" }));
		Object.defineProperty(input, "files", { value: files });
		await act(async () => {
			input?.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
		});
	};

	const submit = async () => {
		const form = container.querySelector("form");
		expect(form).not.toBeNull();
		await act(async () => {
			form?.dispatchEvent(
				new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
	};

	test("overlapping same-name uploads each resolve to their own ref (stage order)", async () => {
		await mount();
		await stage(["ONE", "TWO"]);
		// Both uploads fired before either settled — the overlap.
		expect(uploads.length).toBe(2);
		await act(async () => {
			uploads[0]?.settle.ok(refFor("attachments/one"));
		});
		await act(async () => {
			uploads[1]?.settle.ok(refFor("attachments/two"));
		});
		await submit();
		expect(sent.length).toBe(1);
		expect(sent[0]).toEqual([
			{ type: "data-attachment", data: refFor("attachments/one") },
			{ type: "data-attachment", data: refFor("attachments/two") },
		]);
	});

	test("completion in reverse order still binds each entry to its own upload", async () => {
		await mount();
		await stage(["ONE", "TWO"]);
		expect(uploads.length).toBe(2);
		await act(async () => {
			uploads[1]?.settle.ok(refFor("attachments/two"));
		});
		await act(async () => {
			uploads[0]?.settle.ok(refFor("attachments/one"));
		});
		await submit();
		expect(sent.length).toBe(1);
		expect(sent[0]).toEqual([
			{ type: "data-attachment", data: refFor("attachments/one") },
			{ type: "data-attachment", data: refFor("attachments/two") },
		]);
	});

	test("a failed same-name upload marks only its own entry; the other sends", async () => {
		await mount();
		await stage(["ONE", "TWO"]);
		expect(uploads.length).toBe(2);
		await act(async () => {
			uploads[0]?.settle.fail();
		});
		await act(async () => {
			uploads[1]?.settle.ok(refFor("attachments/two"));
		});
		await submit();
		expect(sent.length).toBe(1);
		expect(sent[0]).toEqual([{ type: "data-attachment", data: refFor("attachments/two") }]);
		// The failed row stays staged as its own chip — the operator can
		// remove it; it must not have swallowed the sibling.
		expect(container.querySelectorAll(".attachment.failed").length).toBe(1);
	});
});
