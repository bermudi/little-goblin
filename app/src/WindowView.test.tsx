import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { WindowView } from "./WindowView.tsx";
import type { AppContextView, AppWindowView } from "../../src/http/app-wire.ts";

// Mounted like MemoryView's tests: the network is faked at
// globalThis.fetch, the DOM is happy-dom, and the test drives clicks.
describe("WindowView", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	// The fixture owns the globals it installs for one test: capture each
	// prior descriptor at install time so afterEach can restore it (deleting
	// only properties that were previously absent).
	let installed: { name: string; prev: PropertyDescriptor | undefined }[] = [];
	const realFetch = globalThis.fetch;

	const installGlobal = (name: string, value: unknown) => {
		installed.push({ name, prev: Reflect.getOwnPropertyDescriptor(globalThis, name) });
		Reflect.set(globalThis, name, value);
	};

	const json = (body: unknown, status = 200): Response =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});

	const VIEW: AppWindowView = {
		model: "zai/glm-5.3-flash",
		capturedAt: "2026-10-22T10:00:00.000Z",
		capturedModel: "zai/glm-5.3-flash",
		steps: 2,
		segments: {
			identity: 900,
			environment: 300,
			project: 0,
			agentsMd: 0,
			userMd: 0,
			skills: 100,
			toolDefs: 400,
			history: 2000,
			toolResults: 500,
		},
		system: "You are goblin.\n\n## environment\n\n- tools: bash",
		tools: [
			{ name: "bash", description: "run a command", parameters: { type: "object" } },
			{ name: "note", description: null, parameters: null },
		],
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "what changed in the repo today?" }],
			},
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "the operator wants the diff" },
					{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "git log" } },
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "c1",
						toolName: "bash",
						output: { type: "text", value: "commit abc123 — fix the gauge" },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "text", text: "and the image?" },
					{ type: "image", image: { omitted: "bytes", count: 1234 }, mediaType: "image/png" },
				],
			},
		],
		calls: [
			{
				callId: "call-1",
				purpose: null,
				model: "zai/glm-5.3-flash",
				startedMs: 1761100000000,
				finishedMs: 1761100002000,
				status: "completed",
				inputTokens: 3100,
				outputTokens: 210,
				cacheRead: 2900,
				cacheWrite: null,
				prefixRelation: "append",
				sharedMessages: 4,
			},
		],
		toolRuns: [
			{
				toolCallId: "tool-1",
				runId: "run-1",
				name: "bash",
				state: "completed",
				beganMs: 1761100001000,
				settledMs: 1761100001500,
				modelCallId: "call-1",
			},
		],
		runs: [
			{
				runId: "run-1",
				startedMs: 1761099999000,
				finishedMs: 1761100003000,
				status: "completed",
				resumedFrom: null,
			},
		],
		nowMs: 1761100004000,
	};

	beforeEach(() => {
		win = new Window();
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		installed = [];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("Event", win.Event);
		installGlobal("MouseEvent", win.MouseEvent);
		installGlobal("requestAnimationFrame", win.requestAnimationFrame.bind(win));
		installGlobal("cancelAnimationFrame", win.cancelAnimationFrame.bind(win));
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
		for (const { name, prev } of installed) {
			if (prev === undefined) Reflect.deleteProperty(globalThis, name);
			else Object.defineProperty(globalThis, name, prev);
		}
		installed = [];
	});

	const CTX: AppContextView = {
		model: "zai/glm-5.3-flash",
		input: 3100,
		output: 210,
		cacheRead: 2900,
		cacheWrite: null,
		cacheHitRate: 2900 / 3100,
		avgCacheHitRate: null,
		limit: 10000,
		pct: 31,
		modelLimit: null,
		turns: 1,
		segments: [{ key: "history", tokens: 1700 }],
	};

	const mount = (over: Partial<AppWindowView> = {}, ctx: Partial<AppContextView> | null = {}) => {
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const path = new URL(url, "http://localhost").pathname;
			if (path === "/api/app/conversations/one/window")
				return Promise.resolve(json({ ...VIEW, ...over }));
			if (path === "/api/app/conversations/one/context")
				return Promise.resolve(
					ctx === null ? json({ error: "down" }, 500) : json({ ...CTX, ...ctx }),
				);
			return Promise.resolve(json({ error: "unmapped" }, 404));
		}) as typeof fetch;
		const onBack = (): boolean => {
			wentBack = true;
			return true;
		};
		let wentBack = false;
		root = createRoot(container);
		act(() => {
			root?.render(
				<WindowView token={null} conversationId="app/one" title="Demo" onBack={onBack} />,
			);
		});
		return {
			backCalled: () => wentBack,
			click: async (el: Element | null | undefined) => {
				expect(el).toBeTruthy();
				await act(async () => {
					(el as HTMLElement).click();
				});
			},
		};
	};

	const button = (label: string) =>
		[...container.querySelectorAll("button")].find((b) => b.textContent === label);
	const expectNoModelCallsFold = () => {
		const summaries = [...container.querySelectorAll("details.win-fold summary")];
		expect(summaries.some((summary) => summary.textContent?.includes("Model calls"))).toBe(false);
	};

	test("renders the captured window and defaults to raw parts", async () => {
		mount();
		await act(async () => {});
		const text = container.textContent ?? "";
		expect(text).toContain("You are goblin.");
		expect(text).toContain("bash");
		// Roles render with the counts; four messages captured.
		expect(container.querySelectorAll(".win-msg").length).toBe(4);
		// Media bytes render as counts, never as an image.
		expect(text).toContain("image/png");
		expect(text).toContain("bytes omitted");
		expect(container.querySelectorAll("img").length).toBe(0);
		expect(text).toContain("Raw parts");
		expect(container.querySelector(".win-traj")).toBeNull();
		expectNoModelCallsFold();
		// The breakdown table names the biggest slice first.
		const rows = [...container.querySelectorAll(".win-break tbody tr")].map(
			(r) => r.firstElementChild?.textContent,
		);
		expect(rows[0]).toBe("history");
		expect(text).toContain("3,700 chars serialized");
		expect(text).toContain("500 of the history are tool calls and results");
	});

	test("leads with used / limit and says when compaction happens", async () => {
		mount();
		await act(async () => {});
		expectNoModelCallsFold();
		const tiles = [...container.querySelectorAll(".sumtile")].map((e) => e.textContent);
		expect(tiles[0]).toContain("3,100");
		expect(tiles[0]).toContain("of 10,000");
		expect(container.textContent).toContain("compacts the history. 6,900 tokens of room remain");
		// The raw parts are folded; nothing scrolls inside the page.
		expect(container.querySelectorAll("details.win-fold[open]").length).toBe(0);
	});

	test("above the threshold the note says the history compacts", async () => {
		mount({}, { input: 10000, pct: 100, modelLimit: 20000 });
		await act(async () => {});
		expectNoModelCallsFold();
		expect(container.textContent).toContain("At or above the 10,000-token limit");
		expect(container.textContent).toContain("The model itself takes up to 20,000.");
	});

	test("without the context read the page still shows the capture", async () => {
		mount({}, null);
		await act(async () => {});
		expectNoModelCallsFold();
		const text = container.textContent ?? "";
		expect(text).toContain("3,700 chars serialized");
		expect(text).not.toContain("room remain");
		expect(text).toContain("No token count for this window");
	});

	test("a null segments row keeps the no-window and no-model states working", async () => {
		const h = mount({
			capturedModel: null,
			segments: null,
			system: null,
			tools: null,
			messages: null,
		});
		await act(async () => {});
		expectNoModelCallsFold();
		const text = container.textContent ?? "";
		expect(text).not.toContain("chars serialized");
		await h.click(button("Trajectory"));
		expect(container.querySelectorAll(".win-table tbody tr")).toHaveLength(1);
	});

	test("role filters narrow the message list, raw JSON swaps the rendering", async () => {
		const h = mount();
		await act(async () => {});
		expectNoModelCallsFold();
		await h.click(button("you"));
		expect(container.querySelectorAll(".win-msg").length).toBe(2);
		// Cards keep their index in the captured window — the second "you"
		// message is #4 of the window, not #2 of the filtered subset.
		expect([...container.querySelectorAll(".win-idx")].map((e) => e.textContent)).toEqual([
			"#1",
			"#4",
		]);
		await h.click(button("tools"));
		expect(container.querySelectorAll(".win-msg").length).toBe(1);
		await h.click(button("all"));
		await h.click(button("raw JSON"));
		const text = container.textContent ?? "";
		expect(text).toContain('"toolCallId"');
	});

	test("the stale-model note appears when the captured model differs", async () => {
		mount({ model: "openai/gpt-6" });
		await act(async () => {});
		expectNoModelCallsFold();
		expect(container.textContent).toContain("now runs openai/gpt-6");
	});

	test("a conversation with no captured window says so and still lists calls", async () => {
		const h = mount({
			capturedAt: null,
			capturedModel: null,
			steps: null,
			segments: null,
			system: null,
			tools: null,
			messages: null,
		});
		await act(async () => {});
		const text = container.textContent ?? "";
		expect(text).not.toContain("No model call yet");
		expect(text).toContain("No captured prompt yet — the window is saved when a turn ends");
		expect(text).toContain("Model calls");
		expect(container.querySelectorAll(".win-table tbody tr")).toHaveLength(1);
		expectNoModelCallsFold();
		expect(container.textContent).not.toContain("No captured prompt yet.");
		await h.click(button("Window"));
		expect(container.querySelector('[data-slot="tabs-panel"]')?.textContent).toContain(
			"No captured prompt yet.",
		);
		expect(container.querySelectorAll("details.win-fold")).toHaveLength(0);
	});

	test("a conversation with no model call shows no tabs", async () => {
		mount({
			capturedAt: null,
			capturedModel: null,
			steps: null,
			segments: null,
			system: null,
			tools: null,
			messages: null,
			calls: [],
			toolRuns: [],
			runs: [],
		});
		await act(async () => {});
		expect(container.textContent).toContain("No model call yet");
		expect(button("Trajectory")).toBeUndefined();
		expect(button("Window")).toBeUndefined();
	});

	test("Trajectory tab shows rows and the calls table", async () => {
		const h = mount();
		await act(async () => {});
		expectNoModelCallsFold();
		await h.click(button("Trajectory"));
		expect(container.querySelectorAll(".win-traj-row")).toHaveLength(1);
		expect(container.textContent).toContain("Model calls");
		expect(container.textContent).toContain("3,100");
		expect(container.textContent).toContain("append");
		await h.click(button("Window"));
		expect(container.querySelector(".win-traj")).toBeNull();
		expectNoModelCallsFold();
	});

	test("back returns to the conversation", async () => {
		const h = mount();
		await act(async () => {});
		expectNoModelCallsFold();
		const back = [...container.querySelectorAll(".ops-back button")].at(-1);
		await h.click(back);
		expect(h.backCalled()).toBe(true);
	});
});
