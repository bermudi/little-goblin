import { afterEach, beforeEach, expect, test, describe } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import {
	authDefaults,
	parseConfig,
	transcriptionDefaults,
	transcriptionKinds,
	fetchKinds,
	searchKinds,
} from "../../src/config.ts";
import { SettingsView } from "./SettingsView.tsx";
import type { ConfigPostBody, ProviderModelCatalog } from "../../src/http/operator-wire.ts";

describe("main branch regressions", () => {
	// The pending provider-name departure guard: a half-typed name sits in
	// the card's blur-commit field, outside every serialized field, so the
	// serialized diff can't see it — it must still arm onDirtyChange and
	// hold the autosave. happy-dom mount, fetch faked at globalThis.fetch.

	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let savedBodies: ConfigPostBody[] = [];
	let dirtyLog: boolean[] = [];
	let settingsGate: Promise<void> | null = null;
	let settings: typeof SETTINGS;
	let modelCatalog: ProviderModelCatalog[];
	let secretGate: ReturnType<typeof Promise.withResolvers<void>>;
	let secretPosts: { name: string; value: string }[] = [];
	const realFetch = globalThis.fetch;
	const globals = new Map<string, PropertyDescriptor | undefined>();

	const SETTINGS = parseConfig({
		providers: {
			main: { kind: "openai-compatible", baseUrl: "https://api.example.test", auth: "fixture" },
		},
		model: "main/test",
		operators: [111],
		allowedUsers: [111],
		telegram: { model: "main/test", thinking: "medium" },
	});

	beforeEach(() => {
		win = new Window({ url: "http://localhost/app/settings" });
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		savedBodies = [];
		dirtyLog = [];
		settingsGate = null;
		settings = SETTINGS;
		modelCatalog = [];
		secretGate = Promise.withResolvers<void>();
		secretPosts = [];
		for (const [name, value] of [
			["window", win],
			["document", win.document],
			["navigator", win.navigator],
			["IS_REACT_ACT_ENVIRONMENT", true],
		] as const) {
			globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
			Reflect.set(globalThis, name, value);
		}
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/app/secrets" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as { name: string; value: string };
				secretPosts.push(body);
				return secretGate.promise.then(
					() =>
						new Response(JSON.stringify({ name: body.name }), {
							headers: { "content-type": "application/json" },
						}),
				);
			}
			if (url === "/api/app/settings" && init?.method === "POST") {
				savedBodies.push(JSON.parse(String(init.body)) as ConfigPostBody);
				return (settingsGate ?? Promise.resolve()).then(
					() =>
						new Response(JSON.stringify({ ok: true }), {
							headers: { "content-type": "application/json", etag: '"v2"' },
						}),
				);
			}
			if (url === "/api/app/settings")
				return Promise.resolve(
					new Response(
						JSON.stringify({
							config: settings,
							providerKinds: ["openai-compatible", "openrouter"],
							searchKinds,
							fetchKinds,
							transcriptionKinds,
							transcriptionDefaults,
							authDefaults,
							authNames: ["main", "groq"],
							modelCatalog,
						}),
						{ headers: { "content-type": "application/json", etag: '"v1"' } },
					),
				);
			if (url.includes("thinking-levels"))
				return Promise.resolve(
					new Response(JSON.stringify({ levels: ["off", "low", "medium", "high"] }), {
						headers: { "content-type": "application/json" },
					}),
				);
			return Promise.reject(new Error(`unexpected request: ${url}`));
		}) as typeof fetch;
	});

	afterEach(async () => {
		settingsGate = null;
		await act(async () => secretGate.resolve());
		await act(async () => root?.unmount());
		root = null;
		await win.happyDOM.close();
		globalThis.fetch = realFetch;
		for (const [name, descriptor] of globals) {
			if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
			else Object.defineProperty(globalThis, name, descriptor);
		}
		globals.clear();
	});

	const settle = async (ms = 30) => {
		await act(async () => {
			await new Promise((r) => setTimeout(r, ms));
		});
	};
	const waitFor = async (pred: () => boolean, label: string) => {
		for (let i = 0; i < 100; i++) {
			if (pred()) return;
			await settle();
		}
		throw new Error(`timed out waiting for ${label}`);
	};
	const click = async (el: Element | null | undefined) => {
		expect(el).toBeTruthy();
		await act(async () => {
			el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
		});
		await settle();
	};
	const typeInto = async (el: Element, value: string) => {
		await act(async () => {
			(el as HTMLElement).focus();
			Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(
				el,
				value,
			);
			el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			el.dispatchEvent(
				new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
			);
		});
		await settle();
	};
	const blur = async (el: Element) => {
		await act(async () => {
			el.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
		});
		await settle();
	};

	const mount = async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(
				// Braces: the component's effect returns the callback's value,
				// and push() returns a number — not a cleanup.
				<SettingsView
					token={null}
					onDirtyChange={(d) => {
						dirtyLog.push(d);
					}}
				/>,
			);
		});
		await waitFor(() => container.querySelector("button.idx") !== null, "settings editor");
	};
	const openProviders = async () => {
		await click(
			[...container.querySelectorAll("button.idx")].find((b) =>
				b.textContent?.includes("Providers"),
			),
		);
		expect(container.querySelector(".prov.card")).not.toBeNull();
	};
	const nameInput = () =>
		container.querySelector('.prov.card input[aria-label="provider name"]') as HTMLInputElement;
	const lastDirty = () => dirtyLog.at(-1);

	const openWeb = async () => {
		await mount();
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Web")),
		);
	};
	const button = (card: Element, text: string) =>
		[...card.querySelectorAll("button")].find((b) => b.textContent === text);
	const changeProvider = async (card: Element, kind: string) => {
		await act(async () => {
			const select = card.querySelector("select")!;
			select.value = kind;
			select.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
		});
		await settle();
	};
	const startStore = async (card: Element) => {
		await click(button(card, "+ store a key"));
		await typeInto(card.querySelector('input[type="password"]')!, "fixture-pending-key");
		await click(button(card, "Store"));
		expect(secretPosts).toHaveLength(1);
	};

	for (const chain of ["search", "fetch"] as const) {
		const kind = chain === "search" ? "brave" : "firecrawl";
		for (const edit of ["remove target", "remove other", "reorder", "edit target", "edit other"]) {
			test(`${chain}: delayed Store preserves ${edit} and the saved chain`, async () => {
				settings = parseConfig({
					...SETTINGS,
					[chain]: [{ kind }, { kind: "jina", auth: "fallback" }],
				});
				await openWeb();
				const cards = () => [...container.querySelectorAll(".chain-card")];
				const authInput = (card: Element) => card.querySelector('input:not([type="password"])')!;
				await typeInto(authInput(cards()[0]!), "");
				await startStore(cards()[0]!);
				let expected = [
					{ kind, auth: kind },
					{ kind: "jina", auth: "fallback" },
				];
				if (edit === "remove target") {
					await click(cards()[0]!.querySelector('[aria-label="remove"]'));
					expected = expected.slice(1);
				} else if (edit === "remove other") {
					await click(cards()[1]!.querySelector('[aria-label="remove"]'));
					expected = expected.slice(0, 1);
				} else if (edit === "reorder") {
					await click(cards()[0]!.querySelector('[aria-label="move down"]'));
					expected.reverse();
				} else {
					const index = edit === "edit target" ? 0 : 1;
					await typeInto(authInput(cards()[index]!), "edited");
					expected[index]!.auth = "edited";
				}
				await act(async () => secretGate.resolve());
				await settle();
				expect(
					cards().map((card) => ({
						kind: card.querySelector("select")!.value,
						auth: (authInput(card) as HTMLInputElement).value,
					})),
				).toEqual(expected);
				await waitFor(() => savedBodies.length > 0 && lastDirty() === false, "updated chain save");
				expect(savedBodies.at(-1)?.[chain]).toEqual(expected);
			});
		}
	}

	for (const edit of ["reorder", "remove target", "edit target"] as const) {
		test(`transcription: delayed Store preserves ${edit} and the saved fallbacks`, async () => {
			settings = parseConfig({
				...SETTINGS,
				transcription: {
					kind: "whistle",
					fallbacks: [{ kind: "groq" }, { kind: "openai", auth: "openai" }],
				},
			});
			await mount();
			await click(
				[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Voice")),
			);
			const cards = () => [...container.querySelectorAll(".chain-card")];
			const authInput = (card: Element) =>
				card.querySelector<HTMLInputElement>('input[aria-label$="secret name"]')!;
			await typeInto(authInput(cards()[0]!), "");
			await startStore(cards()[0]!);
			let expected = [
				{ kind: "groq" as const, auth: "groq", model: transcriptionDefaults.groq.model },
				{ kind: "openai" as const, auth: "openai", model: transcriptionDefaults.openai.model },
			];
			if (edit === "reorder") {
				await click(cards()[0]!.querySelector('[aria-label="move fallback 1 down"]'));
				expected.reverse();
			} else if (edit === "remove target") {
				await click(cards()[0]!.querySelector('[aria-label="remove fallback 1"]'));
				expected = expected.slice(1);
			} else {
				await typeInto(authInput(cards()[0]!), "edited");
				expected[0]!.auth = "edited";
			}
			await act(async () => secretGate.resolve());
			await settle();
			expect(
				cards().map((card) => ({
					kind: card.querySelector("select")!.value,
					auth: authInput(card).value,
				})),
			).toEqual(expected.map(({ kind, auth }) => ({ kind, auth })));
			await waitFor(
				() => savedBodies.length > 0 && lastDirty() === false,
				"updated transcription save",
			);
			const transcription = savedBodies.at(-1)?.transcription;
			expect(transcription && transcription.fallbacks).toEqual(expected);
		});
	}

	test("changing a chain provider clears the pending password before Store", async () => {
		settings = parseConfig({ ...SETTINGS, search: [{ kind: "brave" }] });
		await openWeb();
		const card = container.querySelector(".chain-card")!;
		await click(button(card, "+ store a key"));
		await typeInto(card.querySelector('input[type="password"]')!, "fixture-brave-key");
		await changeProvider(card, "tavily");
		expect(card.querySelector('input[type="password"]')).toBeNull();
		await click(button(card, "+ store a key"));
		const password = card.querySelector<HTMLInputElement>('input[type="password"]')!;
		expect(password.value).toBe("");
		expect(button(card, "Store")?.disabled).toBe(true);
		expect(secretPosts).toEqual([]);
		await typeInto(password, "fixture-tavily-key");
		await click(button(card, "Store"));
		expect(secretPosts).toEqual([{ name: "tavily", value: "fixture-tavily-key" }]);
		await act(async () => secretGate.resolve());
	});

	test("changing the credential record clears the pending password", async () => {
		settings = parseConfig({ ...SETTINGS, search: [{ kind: "brave" }] });
		await openWeb();
		const card = container.querySelector(".chain-card")!;
		await click(button(card, "+ store a key"));
		await typeInto(card.querySelector('input[type="password"]')!, "fixture-old-record-key");
		await typeInto(card.querySelector('input[aria-label="step 1 secret name"]')!, "another-record");
		expect(card.querySelector('input[type="password"]')).toBeNull();
		await click(button(card, "+ store a key"));
		expect(card.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
		expect(button(card, "Store")?.disabled).toBe(true);
		expect(secretPosts).toEqual([]);
	});

	test("a completed Store does not retarget a changed provider", async () => {
		settings = parseConfig({ ...SETTINGS, search: [{ kind: "brave" }] });
		await openWeb();
		const card = container.querySelector(".chain-card")!;
		await startStore(card);
		await changeProvider(card, "tavily");
		await act(async () => secretGate.resolve());
		await settle();
		expect(card.querySelector("select")!.value).toBe("tavily");
		expect(
			card.querySelector<HTMLInputElement>('input[aria-label="step 1 secret name"]')!.value,
		).toBe("");
		await waitFor(() => savedBodies.length > 0 && lastDirty() === false, "changed provider save");
		expect(savedBodies.at(-1)?.search).toEqual([{ kind: "tavily" }]);
	});

	test("a completed Store does not re-enable a disabled chain", async () => {
		settings = parseConfig({ ...SETTINGS, search: [{ kind: "brave" }] });
		await openWeb();
		await startStore(container.querySelector(".chain-card")!);
		await click(container.querySelector('[aria-label="search tool"]'));
		await act(async () => secretGate.resolve());
		await settle();
		expect(container.querySelector(".chain-card")).toBeNull();
		await waitFor(() => savedBodies.length > 0 && lastDirty() === false, "disabled chain save");
		expect(savedBodies.at(-1)?.search).toBe("");
	});

	test("an uncommitted provider name arms the guard and holds the autosave", async () => {
		await mount();
		await openProviders();
		expect(lastDirty()).toBe(false);
		await typeInto(nameInput(), "renamed");
		expect(lastDirty()).toBe(true);
		expect(container.textContent).toContain("provider name (still editing)");
		// The typed name reached no model reference — the card still lists
		// the committed name's referrers — and nothing was written.
		expect(container.querySelector(".prov.card")?.textContent).toContain(
			"Used by app default model",
		);
		// A serialized edit alongside the pending name would normally
		// autosave — the pending flag alone must hold the write. The kind
		// select, not an input: focusing another field would blur-commit
		// the name and end the very state under test.
		await act(async () => {
			const select = container.querySelector(
				'.prov.card select[aria-label="provider type"]',
			) as HTMLSelectElement;
			select.value = "openrouter";
			select.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
		});
		await settle();
		// Well past the 800ms autosave debounce: the held name must not
		// let the old baseline write itself over the pending draft.
		await settle(1000);
		expect(savedBodies).toHaveLength(0);
		expect(lastDirty()).toBe(true);
		// Backtracking to the committed name disarms without a blur — and
		// the held serialized edit finally writes itself.
		await typeInto(nameInput(), "main");
		expect(lastDirty()).toBe(true); // serialized edit still dirty
		await waitFor(() => savedBodies.length > 0, "the held edit to write once the name disarms");
		expect(savedBodies.at(-1)?.providers["main"]).toEqual({
			kind: "openrouter",
			auth: authDefaults.openrouter,
		});
		await waitFor(() => lastDirty() === false, "the guard to clear after the ack");
	});

	test("a committed rename writes itself and the guard clears only after the ack", async () => {
		await mount();
		await openProviders();
		await typeInto(nameInput(), "primary");
		expect(lastDirty()).toBe(true);
		const gate = Promise.withResolvers<void>();
		settingsGate = gate.promise;
		await blur(nameInput());
		// Blur committed: the flag is now serialized dirty, the debounce
		// re-armed, and the write goes out with the renamed provider key.
		await waitFor(() => savedBodies.length > 0, "the rename save");
		expect(savedBodies.at(-1)?.providers["primary"]).toEqual({
			kind: "openai-compatible",
			baseUrl: "https://api.example.test",
			auth: "fixture",
		});
		expect(savedBodies.at(-1)?.providers["main"]).toBeUndefined();
		// The write is still in flight — the guard stays armed until the
		// ack lands the new baseline.
		expect(lastDirty()).toBe(true);
		await act(async () => {
			gate.resolve();
		});
		await waitFor(() => lastDirty() === false, "the guard to clear after the ack");
		expect(container.textContent).not.toContain("unsaved");
	});

	test("an invalid or unchanged commit restores the name and disarms", async () => {
		await mount();
		await openProviders();
		// Whitespace-only: commit rejects, the draft restores, pending clears.
		await typeInto(nameInput(), "   ");
		expect(lastDirty()).toBe(true);
		await blur(nameInput());
		expect(nameInput().value).toBe("main");
		expect(lastDirty()).toBe(false);
		expect(container.textContent).toContain("Every provider needs a name.");
		await settle(900);
		expect(savedBodies).toHaveLength(0);
		// Re-typing the committed name is a no-op commit.
		await typeInto(nameInput(), "main");
		expect(lastDirty()).toBe(false);
		await blur(nameInput());
		expect(lastDirty()).toBe(false);
		await settle(900);
		expect(savedBodies).toHaveLength(0);
	});

	test("removing the provider clears its pending flag — serialized dirty is all that remains", async () => {
		await mount();
		await openProviders();
		await typeInto(nameInput(), "ghost");
		expect(lastDirty()).toBe(true);
		await click(
			[...container.querySelectorAll(".prov.card button")].find((b) => b.textContent === "Remove"),
		);
		// The card is gone and its flag cleared — a stuck pending flag would
		// gate the autosave forever; the removal write itself is the proof.
		expect(container.querySelector(".prov.card")).toBeNull();
		expect(container.textContent).toContain("Removed — still referenced");
		expect(container.textContent).not.toContain("still editing");
		await waitFor(() => savedBodies.length > 0, "the removal save");
		await waitFor(() => lastDirty() === false, "the guard to clear after the ack");
		expect(savedBodies.at(-1)?.providers).toEqual({});
	});

	test("the model sheet searches the catalog by name and picks without typing an id", async () => {
		settings = parseConfig({ ...SETTINGS, favorites: ["main/favorite"] });
		modelCatalog = [
			{
				provider: "main",
				models: [
					{ id: "test", name: "Test Model", releaseDate: "2026-01-01" },
					{ id: "friendly-id", name: "Friendly Flash", releaseDate: "2026-02-01" },
				],
			},
		];
		await mount();
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Chat")),
		);
		await click(container.querySelector('[aria-labelledby="appModelLabel"]'));
		const sheet = container.querySelector(".msheet");
		expect(sheet).not.toBeNull();
		expect(sheet?.textContent).toContain("main/favorite");
		expect(sheet?.textContent).toContain("Friendly Flash");
		await typeInto(sheet!.querySelector('input[aria-label="Search models"]')!, "flash");
		const rows = [...sheet!.querySelectorAll("button.mrow")];
		expect(rows.some((b) => b.textContent?.includes("main/friendly-id"))).toBe(true);
		await click(rows.find((b) => b.textContent?.includes("main/friendly-id")));
		await waitFor(() => savedBodies.length > 0, "the catalog pick to save");
		expect(savedBodies.at(-1)?.model).toBe("main/friendly-id");
	});

	test("the model sheet still accepts a typed ref the catalog does not know", async () => {
		await mount();
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Chat")),
		);
		await click(container.querySelector('[aria-labelledby="appModelLabel"]'));
		const sheet = container.querySelector(".msheet")!;
		await typeInto(sheet.querySelector('input[aria-label="Search models"]')!, "main/new-model");
		expect(sheet.textContent).toContain("Not in the catalog");
		const use = [...sheet.querySelectorAll("button.mrow")].find((b) =>
			b.textContent?.includes("main/new-model"),
		);
		expect(use).toBeTruthy();
		await click(use);
		await waitFor(() => savedBodies.length > 0, "the typed ref to save");
		expect(savedBodies.at(-1)?.model).toBe("main/new-model");
	});
});

describe("quiet harbor regressions", () => {
	// The settings save flow at its boundary (SettingsView + api.ts over a
	// faked fetch): an edit debounces into one POST; success rebaselines; a
	// 422 surfaces the server's message with a retry button; a 409 (stale
	// etag) refuses retry — only reload helps; and a failed signature is
	// never re-fired by the debounce.

	// GET /api/app/settings payload — no providers keeps the thinking-level
	// lookups away (a "p/m" model with no matching provider resolves to the
	// full ladder without a fetch).
	const SETTINGS_BODY = {
		config: {
			providers: {},
			model: "p/m",
			titleModel: "",
			favorites: [],
			thinking: "medium",
			tts: false,
			operators: [1],
			allowedUsers: [1],
			telegram: {
				model: "p/m",
				thinking: "medium",
				apiRoot: "",
				dmGapMinutes: 45,
				richReplies: true,
				showReasoning: false,
			},
			publicUrl: "",
			http: { port: 8787 },
			logLevel: "info",
		},
		providerKinds: ["openai-compatible", "responses", "openrouter", "codex"],
		searchKinds: searchKinds,
		fetchKinds: fetchKinds,
		transcriptionKinds,
		transcriptionDefaults,
		authDefaults,
		authNames: [],
		modelCatalog: [],
	};

	const json = (body: unknown, init: { status?: number; etag?: string } = {}): Response =>
		new Response(JSON.stringify(body), {
			status: init.status ?? 200,
			headers: {
				"content-type": "application/json",
				...(init.etag !== undefined ? { etag: init.etag } : {}),
			},
		});

	describe("SettingsView save flow", () => {
		let win: Window;
		let container: HTMLElement;
		let root: Root | null = null;
		let installed: string[] = [];
		const realFetch = globalThis.fetch;

		const installGlobal = (name: string, value: unknown) => {
			Reflect.set(globalThis, name, value);
			installed.push(name);
		};

		// The POST script: each queued entry is a Response or an async gate;
		// requests records every wire hit.
		let posts: Request[] = [];
		let postScript: Array<Response | (() => Promise<Response>)> = [];

		beforeEach(() => {
			win = new Window({ url: "http://localhost/app/settings" });
			const div = win.document.createElement("div");
			win.document.body.appendChild(div);
			container = div as unknown as HTMLElement;
			installed = [];
			installGlobal("window", win);
			installGlobal("document", win.document);
			installGlobal("navigator", win.navigator);
			installGlobal("localStorage", win.localStorage);
			installGlobal("Event", win.Event);
			installGlobal("CustomEvent", win.CustomEvent);
			installGlobal("getComputedStyle", win.getComputedStyle);
			Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
			posts = [];
			postScript = [];
			globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				const req = new Request(new URL(String(input), "http://localhost"), init);
				if (req.method === "POST" && new URL(req.url).pathname === "/api/app/settings") {
					posts.push(req);
					const next = postScript.shift() ?? json({ ok: true }, { etag: '"v2"' });
					return typeof next === "function" ? next() : next;
				}
				return json(SETTINGS_BODY, { etag: '"v1"' });
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

		const tick = (ms = 50) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

		async function mount(): Promise<void> {
			await act(async () => {
				root = createRoot(container);
				root.render(<SettingsView token="tok" />);
			});
			await tick(120);
		}

		const savebar = () => container.querySelector(".savebar-msg")?.textContent ?? "";
		const retryButton = () =>
			[...container.querySelectorAll("button")].find((b) => b.textContent === "retry");

		// Public URL is deliberately staged, so use an ordinary autosaved field.
		async function editLogLevel(): Promise<void> {
			const access = [...container.querySelectorAll("button")].find((b) =>
				b.textContent?.includes("Access"),
			);
			if (access === undefined) throw new Error("Access section button not found");
			await act(async () => {
				access.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
			});
			const debug = [...container.querySelectorAll('[aria-label="Log level"] button')].find(
				(b) => b.textContent === "debug",
			);
			if (debug === undefined) throw new Error("Debug log-level button not found");
			await act(async () => {
				debug.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
			});
		}

		test("a valid edit debounces into one POST and the savebar confirms", async () => {
			await mount();
			expect(savebar()).toBe("");
			await editLogLevel();
			await tick(120); // under the 800ms debounce — nothing yet
			expect(posts).toHaveLength(0);
			expect(savebar()).toContain("Unsaved");
			await tick(900);
			expect(posts).toHaveLength(1);
			expect(posts[0]!.headers.get("if-match")).toBe('"v1"');
			expect(posts[0]!.headers.get("authorization")).toBe("Bearer tok");
			expect(savebar()).toBe("Saved.");
			// Baseline flipped — the unsaved pill is gone.
			expect(container.textContent).not.toContain("unsaved");
		});

		test("a 422 surfaces the server's message and keeps the retry button", async () => {
			postScript.push(json({ error: "operators may not be empty" }, { status: 422 }));
			await mount();
			await editLogLevel();
			await tick(950);
			expect(posts).toHaveLength(1);
			expect(savebar()).toBe("operators may not be empty");
			expect(retryButton()).toBeTruthy();
			await act(async () => {
				retryButton()!.dispatchEvent(
					new win.MouseEvent("click", { bubbles: true }) as unknown as Event,
				);
			});
			await tick(120);
			expect(posts).toHaveLength(2);
			expect(savebar()).toBe("Saved.");
		});

		test("a 409 demands a reload — no retry button", async () => {
			postScript.push(json({ error: "config changed" }, { status: 409 }));
			await mount();
			await editLogLevel();
			await tick(950);
			expect(posts).toHaveLength(1);
			expect(savebar()).toContain("reload the page");
			expect(retryButton()).toBeUndefined();
		});

		test("a failed write isn't re-fired by the debounce on identical state", async () => {
			postScript.push(json({ error: "boom" }, { status: 500 }));
			await mount();
			await editLogLevel();
			await tick(950);
			expect(posts).toHaveLength(1);
			// Two more debounce windows — no chained retries.
			await tick(1800);
			expect(posts).toHaveLength(1);
			expect(savebar()).toBe("boom");
		});
	});
});
