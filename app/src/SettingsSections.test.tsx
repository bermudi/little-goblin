import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import {
	authDefaults,
	parseConfig,
	transcriptionDefaults,
	ttsCloudDefaults,
	transcriptionKinds,
	fetchKinds,
	searchKinds,
} from "../../src/config.ts";
import { SettingsView } from "./SettingsView.tsx";
import { KeyStatus } from "./settingsKit.tsx";
import type { ConfigPostBody } from "../../src/http/operator-wire.ts";

// DOM harness shared by the KeyStatus unit tests and the section
// walkthroughs — same happy-dom mount and faked fetch as
// SettingsView.test.tsx, different fixtures per test.

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
let savedBodies: ConfigPostBody[] = [];
let settings: ReturnType<typeof parseConfig>;
let caps: ReturnType<typeof CAPS>;
let chatgptStatus: Record<string, unknown>;
let statusFailure: Response | null;
let restartHints: string[];
const realFetch = globalThis.fetch;
const globals = new Map<string, PropertyDescriptor | undefined>();

const CAPS = (over: Record<string, { state: string; hint: string | null }> = {}) =>
	Object.fromEntries(
		[
			"memory",
			"transcription",
			"vision",
			"image",
			"sandbox",
			"subagents",
			"scripting",
			"delegation",
			"guest",
			"reviewer",
		].map((k) => [k, over[k] ?? { state: "off", hint: null }]),
	);

const BASE = parseConfig({
	providers: {
		main: { kind: "openai-compatible", baseUrl: "https://api.example.test", auth: "fixture" },
	},
	model: "main/test",
	operators: [111],
	allowedUsers: [111],
	telegram: { model: "main/test", thinking: "medium" },
});

const SERVICE_NAMES = {
	brave: "Brave Search",
	jina: "Jina",
	tavily: "Tavily",
	firecrawl: "Firecrawl",
	parallel: "Parallel",
	ddg: "DuckDuckGo",
	local: "Built-in",
	edge: "Edge voices (free)",
	openrouter: "OpenRouter",
	onemin: "1min.AI",
	whistle: "Whistle (on this machine)",
	groq: "Groq",
	openai: "OpenAI",
	codex: "ChatGPT",
} as const;

beforeEach(() => {
	win = new Window({ url: "http://localhost/app/settings" });
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
	savedBodies = [];
	settings = BASE;
	caps = CAPS();
	statusFailure = null;
	restartHints = [];
	chatgptStatus = {
		state: "signed-out",
		source: null,
		email: null,
		plan: null,
		pending: null,
		error: null,
		pinned: false,
	};
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
		if (url === "/api/app/settings" && init?.method === "POST") {
			savedBodies.push(JSON.parse(String(init.body)) as ConfigPostBody);
			return Promise.resolve(
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
						providerKinds: ["openai-compatible", "responses", "openrouter", "codex"],
						searchKinds,
						fetchKinds,
						transcriptionKinds,
						transcriptionDefaults,
						ttsDefaults: ttsCloudDefaults,
						authDefaults,
						authNames: ["fixture"],
						authCommandNames: ["pass-managed"],
						serviceNames: SERVICE_NAMES,
						providerPresets: [
							{
								id: "zai",
								name: "Z.ai",
								provider: { kind: "responses", baseUrl: "https://api.z.ai/api/v1", auth: "zai" },
							},
						],
						capabilities: caps,
						modelCatalog: [],
					}),
					{ headers: { "content-type": "application/json", etag: '"v1"' } },
				),
			);
		if (url.includes("/api/app/accounts/chatgpt"))
			return Promise.resolve(
				new Response(JSON.stringify(chatgptStatus), {
					headers: { "content-type": "application/json" },
				}),
			);
		if (url === "/api/app/status" && statusFailure !== null)
			return Promise.resolve(statusFailure.clone());
		if (url === "/api/app/status")
			return Promise.resolve(
				new Response(
					JSON.stringify({
						version: "0.0.0-test",
						startedAt: "2026-01-01T00:00:00.000Z",
						uptimeSec: 60,
						restartHints,
						memory: { state: "off", detail: "", lastRecallAt: null },
						programs: null,
						delegations: null,
					}),
					{ headers: { "content-type": "application/json" } },
				),
			);
		return Promise.reject(new Error(`unexpected request: ${url}`));
	}) as typeof fetch;
});

afterEach(async () => {
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
		Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(el, value);
		el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
		el.dispatchEvent(
			new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
		);
	});
	await settle();
};

const mountSettings = async () => {
	root = createRoot(container);
	await act(async () => {
		root?.render(<SettingsView token={null} onDirtyChange={() => {}} />);
	});
	await waitFor(() => container.querySelector("button.idx") !== null, "settings editor");
};
const openSection = async (label: string) => {
	await click(
		[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes(label)),
	);
};

describe("KeyStatus", () => {
	const render = async (props: {
		name: string;
		keyless?: boolean;
		commandNames?: string[];
		authNames?: string[];
	}) => {
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<KeyStatus
					token={null}
					name={props.name}
					keyless={props.keyless === true}
					commandNames={props.commandNames ?? []}
					authNames={props.authNames ?? []}
					onStored={() => {}}
				/>,
			);
		});
		await settle();
	};

	test("keyless kinds state 'No key needed' with no buttons", async () => {
		await render({ name: "", keyless: true });
		expect(container.textContent).toContain("No key needed");
		expect(container.querySelector("button")).toBeNull();
	});

	test("a command record shows 'From pass-keys' with no paste control", async () => {
		await render({ name: "brave", commandNames: ["brave"] });
		expect(container.textContent).toContain("From pass-keys");
		expect(container.querySelector("button")).toBeNull();
	});

	test("a saved record shows 'Key saved' and a Replace action", async () => {
		await render({ name: "main", authNames: ["main"] });
		expect(container.textContent).toContain("Key saved");
		expect(
			[...container.querySelectorAll("button")].find((b) => b.textContent === "Replace"),
		).toBeTruthy();
	});

	test("a missing record warns 'Key missing' and offers Add key", async () => {
		await render({ name: "brave" });
		expect(container.textContent).toContain("Key missing");
		expect(
			[...container.querySelectorAll("button")].find((b) => b.textContent === "Add key"),
		).toBeTruthy();
	});

	test("Add key opens the paste box; Store calls /secrets and reports the name", async () => {
		const stored: string[] = [];
		const posts: { name: string; value: string }[] = [];
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { name: string; value: string };
			posts.push(body);
			return Promise.resolve(
				new Response(JSON.stringify({ name: body.name }), {
					headers: { "content-type": "application/json" },
				}),
			);
		}) as typeof fetch;
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<KeyStatus
					token={null}
					name="brave"
					keyless={false}
					commandNames={[]}
					authNames={[]}
					onStored={(n) => stored.push(n)}
				/>,
			);
		});
		await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Add key"));
		await typeInto(container.querySelector('input[type="password"]')!, "k3y");
		await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Store"));
		expect(posts).toEqual([{ name: "brave", value: "k3y" }]);
		expect(stored).toEqual(["brave"]);
	});
});

describe("Accounts & keys", () => {
	test("codex providers are excluded from model services", async () => {
		settings = parseConfig({
			providers: {
				main: { kind: "openai-compatible", baseUrl: "https://api.example.test", auth: "fixture" },
				codex: { kind: "codex" },
			},
			model: "main/test",
			operators: [111],
			allowedUsers: [111],
			telegram: { model: "main/test" },
		});
		await mountSettings();
		await openSection("Accounts & keys");
		const cards = [...container.querySelectorAll(".chain-card")];
		const text = cards.map((c) => c.textContent).join("|");
		expect(text).toContain("main");
		expect(text).not.toContain("codex");
	});

	test("preset add stores preset.provider verbatim", async () => {
		await mountSettings();
		await openSection("Accounts & keys");
		await click(
			[...container.querySelectorAll("button")].find(
				(b) => b.textContent === "+ Add model service",
			),
		);
		const select = container.querySelector('select[aria-label="add a service"]')!;
		expect(select.textContent).toContain("Z.ai");
		await act(async () => {
			(select as HTMLSelectElement).value = "zai";
			select.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
		});
		await settle();
		await waitFor(() => savedBodies.length > 0, "preset add save");
		expect(savedBodies.at(-1)?.providers?.zai).toEqual({
			kind: "responses",
			baseUrl: "https://api.z.ai/api/v1",
			auth: "zai",
		});
	});

	test("custom endpoint adds an openai-compatible provider", async () => {
		await mountSettings();
		await openSection("Accounts & keys");
		await click(
			[...container.querySelectorAll("button")].find(
				(b) => b.textContent === "+ Add model service",
			),
		);
		const select = container.querySelector('select[aria-label="add a service"]')!;
		await act(async () => {
			(select as HTMLSelectElement).value = "__custom";
			select.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
		});
		await settle();
		await typeInto(container.querySelector('input[aria-label="service name"]')!, "custom-svc");
		await typeInto(
			container.querySelector('input[aria-label="custom base url"]')!,
			"https://custom.test/v1",
		);
		await click(
			[...container.querySelectorAll("button")].find((b) => b.textContent === "Add service"),
		);
		await waitFor(() => savedBodies.length > 0, "custom add save");
		expect(savedBodies.at(-1)?.providers?.["custom-svc"]).toEqual({
			kind: "openai-compatible",
			baseUrl: "https://custom.test/v1",
			auth: "custom-svc",
		});
	});

	test("service keys card lists the records chains and voice point at", async () => {
		settings = parseConfig({
			...BASE,
			search: [{ kind: "brave" }],
			transcription: { kind: "whistle", fallbacks: [{ kind: "groq" }] },
		});
		await mountSettings();
		await openSection("Accounts & keys");
		const card = [...container.querySelectorAll(".card")].find((c) =>
			c.textContent?.includes("Brave Search"),
		)!;
		expect(card).toBeTruthy();
		expect(card.textContent).toContain("Groq");
		expect(card.textContent).toContain("Search");
		expect(card.textContent).toContain("Transcription");
		// No secret-name inputs anywhere.
		expect(container.querySelector('input[aria-label*="secret name"]')).toBeNull();
		expect(container.textContent).not.toContain("auth.jsonl");
	});
});

describe("Web", () => {
	test("rows and the add-select show display names; keyless kinds marked", async () => {
		settings = parseConfig({ ...BASE, search: [{ kind: "brave" }] });
		await mountSettings();
		await openSection("Web");
		expect(container.textContent).toContain("Brave Search");
		const select = [...container.querySelectorAll('select[aria-label="add a service"]')][0]!;
		expect(select.textContent).toContain("DuckDuckGo (no key)");
		// Page reading defaults to the built-in row.
		expect(container.textContent).toContain("Built-in");
	});

	test('fetch back to just the built-in saves ""', async () => {
		settings = parseConfig({ ...BASE, fetch: [{ kind: "jina" }] });
		await mountSettings();
		await openSection("Web");
		const fetchCard = [...container.querySelectorAll(".card")].find((c) =>
			c.textContent?.includes("Jina"),
		)!;
		await click(fetchCard.querySelector('[aria-label="remove"]'));
		await waitFor(() => savedBodies.length > 0, "fetch clear save");
		expect(savedBodies.at(-1)?.fetch).toBe("");
	});

	test("no secret-name inputs or auth.jsonl text on the page", async () => {
		settings = parseConfig({ ...BASE, search: [{ kind: "brave" }] });
		await mountSettings();
		await openSection("Web");
		expect(container.querySelector('input[aria-label*="secret name"]')).toBeNull();
		expect(container.textContent).not.toContain("auth.jsonl");
	});
});

describe("Voice", () => {
	test("whistle keywords edit and round-trip to the saved block", async () => {
		settings = parseConfig({
			...BASE,
			transcription: { kind: "whistle", keywords: ["goblin"] },
		});
		await mountSettings();
		await openSection("Voice");
		const input = container.querySelector('input[aria-label="add keyword"]')!;
		await typeInto(input, "herdr");
		await click(
			[...input.closest(".card")!.querySelectorAll("button")].find((b) => b.textContent === "Add"),
		);
		await waitFor(() => savedBodies.length > 0, "keywords save");
		const tr = savedBodies.at(-1)?.transcription;
		expect(typeof tr === "object" ? tr.keywords : null).toEqual(["goblin", "herdr"]);
	});

	test("no secret-name inputs in transcription or speaking", async () => {
		settings = parseConfig({ ...BASE, transcription: { kind: "whistle" } });
		await mountSettings();
		await openSection("Voice");
		expect(container.querySelector('input[aria-label*="secret name"]')).toBeNull();
		expect(container.textContent).not.toContain("auth.jsonl");
	});
});

describe("Capabilities + memory", () => {
	test("flipping a capability sends only the diff key", async () => {
		await mountSettings();
		await openSection("Capabilities");
		await click(container.querySelector('[aria-label="Sandboxed shell"]'));
		await waitFor(() => savedBodies.length > 0, "capability save");
		expect(savedBodies.at(-1)?.capabilities).toEqual({ sandbox: true });
	});

	test("a needs-setup capability renders disabled with the hint", async () => {
		caps = CAPS({
			subagents: {
				state: "needs-setup",
				hint: "set it up in goblin.json5 first (docs/configuration.md)",
			},
		});
		await mountSettings();
		await openSection("Capabilities");
		const sw = container.querySelector(
			'[aria-label="Subagents & computer use"]',
		) as HTMLButtonElement;
		expect(sw.disabled).toBe(true);
		expect(container.textContent).toContain("set it up in goblin.json5 first");
	});

	test("chatgpt pending → signed-in reloads the settings GET when clean", async () => {
		chatgptStatus = {
			state: "pending",
			source: null,
			email: null,
			plan: null,
			pending: {
				userCode: "ZZZZ-9999",
				verificationUrl: "https://auth.openai.com/codex/device",
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			},
			error: null,
			pinned: false,
		};
		let settingsGets = 0;
		const inner = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/app/settings" && init?.method !== "POST") settingsGets++;
			return inner(input, init);
		}) as typeof fetch;
		await mountSettings();
		await openSection("Accounts & keys");
		const before = settingsGets;
		// Flip the scripted status — the card's next poll sees signed-in.
		chatgptStatus = {
			state: "signed-in",
			source: "goblin",
			email: "op@example.test",
			plan: null,
			pending: null,
			error: null,
			pinned: false,
		};
		await waitFor(() => settingsGets > before, "the settings reload after sign-in");
	});

	for (const transcription of [
		{
			kind: "groq",
			model: "whisper-large-v3",
			auth: "saved-groq",
			language: "en",
			fallbacks: [
				{
					kind: "whistle",
					engine: "saved-engine",
					weights: "/fixture/weights",
					keywords: ["goblin"],
				},
			],
		},
		{
			kind: "whistle",
			engine: "saved-engine",
			weights: "/fixture/weights",
			keywords: ["goblin"],
			language: "en",
			fallbacks: [{ kind: "openai", model: "whisper-1", auth: "saved-openai", language: "es" }],
		},
	]) {
		test(`reopening Settings restores parked ${transcription.kind} transcription whole`, async () => {
			settings = parseConfig({ ...BASE, parked: { transcription } });
			await mountSettings();
			await openSection("Voice");
			const toggle = () => container.querySelector('[aria-label="speech to text"]');
			expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
			await click(toggle());
			expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
			await waitFor(() => savedBodies.length > 0, "transcription restoration save");
			expect(savedBodies.at(-1)?.capabilities).toEqual({ transcription: true });
			expect<unknown>(savedBodies.at(-1)?.transcription).toEqual(settings.parked?.transcription);
		});
	}

	test("parked memory enables visibly, preserves policy, then disables after save", async () => {
		settings = parseConfig({
			...BASE,
			parked: {
				memory: {
					baseUrl: "https://mem.test",
					bankId: "saved-bank",
					auth: "saved-memory",
					budget: "high",
					maxTokens: 1234,
					recallTimeoutMs: 5678,
					preferObservations: true,
					searchMaxTokens: 4321,
				},
			},
		});
		await mountSettings();
		await openSection("Memory");
		const toggle = () => container.querySelector('[aria-label="long-term memory"]');
		expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
		await click(toggle());
		expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
		expect(container.textContent).toContain("saved-bank");
		await waitFor(() => savedBodies.length > 0, "memory restoration save");
		expect(savedBodies.at(-1)?.capabilities).toEqual({ memory: true });
		expect<unknown>(savedBodies.at(-1)?.memory).toEqual(settings.parked?.memory);
		await settle();
		await click(toggle());
		expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
		await waitFor(() => savedBodies.length === 2, "memory disabled again");
		expect(savedBodies.at(-1)?.capabilities).toEqual({ memory: false });
		expect(savedBodies.at(-1)?.memory).toBe("");
	});

	for (const known of [false, true]) {
		test(`status failure after save reports uncertainty${known ? " and retains known restart hints" : ""}`, async () => {
			restartHints = known ? ["memory"] : [];
			await mountSettings();
			await openSection("Capabilities");
			statusFailure = new Response(JSON.stringify({ error: "status unavailable" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			});
			await click(container.querySelector('[aria-label="Sandboxed shell"]'));
			await waitFor(
				() => container.textContent?.includes("Couldn't check service status") ?? false,
				"failed status warning",
			);
			expect(savedBodies).toHaveLength(1);
			expect(container.textContent).toContain("status unavailable");
			expect(container.textContent).toContain("Restart requirements are unconfirmed");
			if (known)
				expect(container.querySelector(".restart-banner")?.textContent).toContain("memory");
			statusFailure = null;
			await click(container.querySelector('[aria-label="Sandboxed shell"]'));
			await waitFor(
				() => savedBodies.length === 2 && container.querySelector('[role="alert"]') === null,
				"successful status recheck clears warning",
			);
		});
	}

	test("initial status failure is visible even without a previous successful check", async () => {
		statusFailure = new Response("not JSON", { headers: { "content-type": "application/json" } });
		await mountSettings();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Couldn't check service status",
		);
		expect(container.textContent).toContain("Restart requirements are unconfirmed");
	});

	test("switching memory off parks the block", async () => {
		settings = parseConfig({
			...BASE,
			memory: { baseUrl: "https://mem.test", bankId: "b1" },
		});
		await mountSettings();
		await openSection("Memory");
		await click(container.querySelector('[aria-label="long-term memory"]'));
		await waitFor(() => savedBodies.length > 0, "memory park save");
		expect(savedBodies.at(-1)?.memory).toBe("");
	});
});
