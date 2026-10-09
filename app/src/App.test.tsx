import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { App, deepLinkConv, flatLine } from "./App.tsx";

// Stored titles predate store-side flattening — the sidebar row must
// render them clean regardless of the server's vintage.

describe("flatLine", () => {
	test("a fenced title loses the fence and language tag", () => {
		expect(flatLine("```typescript const slug = (s: string): string => s.trim(); ```")).toBe(
			"const slug = (s: string): string => s.trim();",
		);
	});

	test("inline backticks, links, and emphasis flatten", () => {
		expect(flatLine("run `bun test` then see [docs](https://a.dev) — **bold**")).toBe(
			"run bun test then see docs — bold",
		);
	});

	test("line-lead markers and whitespace collapse", () => {
		expect(flatLine("## multi\n   line   title")).toBe("multi line title");
	});

	test("a title reduced to markdown furniture empties out", () => {
		expect(flatLine("``` ```")).toBe("");
	});
});

// The spin-off deep link — /app/c/<appId> claims the conversation id.
describe("deepLinkConv", () => {
	test("a valid path yields the app/ conversation id", () => {
		expect(deepLinkConv("/app/c/spun-1_valid")).toBe("app/spun-1_valid");
	});
	test("the root, other paths, and malformed ids claim nothing", () => {
		expect(deepLinkConv("/app/")).toBeNull();
		expect(deepLinkConv("/app/c/")).toBeNull();
		expect(deepLinkConv("/app/c/-bad")).toBeNull();
		expect(deepLinkConv("/app/c/valid/extra")).toBeNull();
		expect(deepLinkConv("/settings")).toBeNull();
	});
});

// The empty-state send creates the conversation and unmounts that
// composer (#118): an upload still in flight resolves after the
// unmount, and its chip must still be there in the new conversation's
// composer — staged uploads belong to the operator's composer, not to
// whichever instance happens to be mounted. Full App mount in
// happy-dom like ChatView.test.tsx; the wire (api.ts + the SDK's
// transport) is faked at globalThis.fetch, with the upload POSTs held
// back so the test owns when each one finishes.
interface Deferred {
	promise: Promise<Response>;
	settle: {
		ok: (ref: { path: string; mediaType: string; filename: string; size: number }) => void;
	};
}

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function deferredUpload(): Deferred {
	let ok!: (res: Response) => void;
	const promise = new Promise<Response>((res) => {
		ok = res;
	});
	return {
		promise,
		settle: {
			ok: (ref) => ok(jsonResponse({ ref }, 201)),
		},
	};
}

describe("App empty-state send keeps unfinished uploads (issue #118)", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let uploads: Deferred[] = [];
	let created = false;
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
		created = false;
		installed = [];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			if (url === "/api/app/attachments") {
				const d = deferredUpload();
				uploads.push(d);
				return d.promise;
			}
			if (url === "/api/app/conversations") {
				if (method === "POST") {
					created = true;
					return Promise.resolve(jsonResponse({ id: "app/fixture", title: null }));
				}
				return Promise.resolve(
					jsonResponse({
						conversations: created
							? [
									{
										id: "app/fixture",
										title: null,
										preview: "fixture",
										updatedAt: new Date().toISOString(),
									},
								]
							: [],
					}),
				);
			}
			if (url.endsWith("/messages")) return Promise.resolve(jsonResponse({ messages: [] }));
			if (url.endsWith("/stream")) return Promise.resolve(new Response(null, { status: 204 }));
			if (url.endsWith("/chat"))
				return Promise.resolve(
					new Response("data: [DONE]\n\n", {
						status: 200,
						headers: {
							"content-type": "text/event-stream",
							"x-vercel-ai-ui-message-stream": "v1",
						},
					}),
				);
			// The composers' config loads and anything else.
			return Promise.resolve(
				jsonResponse({
					model: "fixture/model",
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

	test("an upload still in flight when the conversation is created stays staged", async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		// Gate probe + first list load land before there is a DOM to poke.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});

		const input = container.querySelector('input[type="file"]');
		expect(input).not.toBeNull();
		Object.defineProperty(input, "files", {
			value: [
				new File(["a"], "ready.jpg", { type: "image/jpeg" }),
				new File(["b"], "pending.jpg", { type: "image/jpeg" }),
			],
		});
		await act(async () => {
			input?.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
		});
		expect(uploads.length).toBe(2);
		await act(async () => {
			uploads[0]?.settle.ok({
				path: "attachments/ready",
				mediaType: "image/jpeg",
				filename: "ready.jpg",
				size: 1,
			});
		});
		// The still-uploading chip is part of the composer before the send.
		expect(container.textContent).toContain("pending.jpg");

		// Send: the ready attachment creates the conversation — the
		// empty-state composer unmounts, ChatView mounts with the seed.
		await act(async () => {
			container
				.querySelector("form")
				?.dispatchEvent(
					new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
				);
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 30));
		});
		expect(created).toBe(true);

		// The second upload finishes after the unmount — its chip must
		// still be there in the new conversation's composer.
		await act(async () => {
			uploads[1]?.settle.ok({
				path: "attachments/pending",
				mediaType: "image/jpeg",
				filename: "pending.jpg",
				size: 1,
			});
		});
		expect(container.textContent).toContain("pending.jpg");
	});
});
