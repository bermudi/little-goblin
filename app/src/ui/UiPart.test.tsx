// UiPart render contract: complete inputs render the component tree,
// partial inputs render what validates plus a skeleton tail, bad
// payloads fall back to the generic tool row — never a blank. The
// sandbox and action pins are boundary tests: the iframe's sandbox
// string and the [ui] message format are the parts a regression
// would silently weaken.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { ToolUIPart, UIMessage } from "ai";
import fixture from "../../../src/agent/tools/testdata/ui-all-blocks.json" with { type: "json" };
import { MessageParts } from "../ChatView.tsx";
import { UiPart } from "./UiPart.tsx";

function uiPart(p: Record<string, unknown>): ToolUIPart {
	return { type: "tool-ui", toolCallId: "u1", ...p } as unknown as ToolUIPart;
}

describe("UiPart (static markup)", () => {
	test("output-available renders every leaf and container class", () => {
		const html = renderToStaticMarkup(
			<UiPart part={uiPart({ state: "output-available", input: fixture, output: "shown" })} />,
		);
		for (const kind of [
			"text",
			"callout",
			"stats",
			"table",
			"steps",
			"chart",
			"choices",
			"form",
			"tabs",
			"columns",
			"html",
		]) {
			expect(html, `missing ui-${kind}`).toContain(`ui-${kind}`);
		}
	});

	test("input-streaming renders complete blocks and one tail skeleton", () => {
		const html = renderToStaticMarkup(
			<UiPart
				part={uiPart({
					state: "input-streaming",
					input: {
						title: "arriving",
						blocks: [
							{ type: "text", md: "done block" },
							{ type: "stats", items: [{ label: "n", value: "1" }] },
							{ type: "table" }, // truncated — still streaming
						],
					},
				})}
			/>,
		);
		expect(html).toContain("ui-text");
		expect(html).toContain("done block");
		expect(html).toContain("ui-stats");
		expect(html).not.toContain("ui-table");
		// Exactly one Skeleton component (each renders skel-a + skel-b).
		expect(html.match(/skel skel-a/g)?.length).toBe(1);
		expect(html.match(/skel skel-b/g)?.length).toBe(1);
	});

	test("input-streaming never mounts an html iframe", () => {
		const htmlBlock = fixture.blocks.find((b) => b.type === "html")!;
		const html = renderToStaticMarkup(
			<UiPart part={uiPart({ state: "input-streaming", input: { blocks: [htmlBlock] } })} />,
		);
		expect(html).not.toContain("<iframe");
		expect(html).toContain("skel");
	});

	test("input-streaming never mounts an html iframe nested in a container", () => {
		const htmlBlock = fixture.blocks.find((b) => b.type === "html")!;
		const tabsBlock = {
			type: "tabs",
			tabs: [
				{ label: "one", blocks: [htmlBlock] },
				{ label: "two", blocks: [{ type: "text", md: "plain" }] },
			],
		};
		const html = renderToStaticMarkup(
			<UiPart part={uiPart({ state: "input-streaming", input: { blocks: [tabsBlock] } })} />,
		);
		expect(html).not.toContain("<iframe");
		expect(html).toContain("skel");
	});

	test("duplicate form names never render, including during streaming", () => {
		const input = {
			blocks: [
				{
					type: "form",
					fields: [
						{ name: "amount", label: "Amount", kind: "number" },
						{ name: "amount", label: "Note", kind: "text" },
					],
					submit: "Send",
				},
			],
		};
		for (const state of ["input-streaming", "output-available"]) {
			const html = renderToStaticMarkup(
				<UiPart part={uiPart({ state, input, output: "shown" })} />,
			);
			expect(html).not.toContain("<form");
			expect(html).toContain(state === "input-streaming" ? "skel" : "tool-run");
		}
	});

	// A leaf's md can be a still-arriving prefix — an unclosed note
	// fence inside one must not offer its append affordance until the
	// input lands (or the transcript reloads settled).
	test("an unclosed note fence stays non-actionable while its ui block streams", () => {
		const input = { blocks: [{ type: "text", md: "```note\npartial body" }] };
		const streaming = renderToStaticMarkup(
			<UiPart part={uiPart({ state: "input-streaming", input })} />,
		);
		expect(streaming).toContain("note-card");
		expect(streaming).toContain("partial body");
		expect(streaming).not.toContain("note-card-append");
		const settled = renderToStaticMarkup(
			<UiPart part={uiPart({ state: "output-available", input, output: "shown" })} />,
		);
		expect(settled).toContain("note-card-append");
	});

	test("a schema-failing input falls back to the generic tool row", () => {
		const html = renderToStaticMarkup(
			<UiPart
				part={uiPart({
					state: "output-available",
					input: { blocks: [{ type: "frobnicate" }] },
					output: "shown",
				})}
			/>,
		);
		expect(html.length).toBeGreaterThan(0);
		expect(html).toContain("tool-run");
		expect(html).toContain(">ui</span>");
	});
});

// Interaction + DOM-attribute pins need a real element tree.
describe("UiPart + MessageParts (happy-dom)", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: [string, PropertyDescriptor | undefined][] = [];

	const installGlobal = (name: string, value: unknown) => {
		installed.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
		Reflect.set(globalThis, name, value);
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
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	});

	afterEach(async () => {
		if (root !== null) {
			await act(async () => {
				root?.unmount();
			});
			root = null;
		}
		await win.happyDOM.close();
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		for (const [name, descriptor] of installed) {
			if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
			else Object.defineProperty(globalThis, name, descriptor);
		}
		installed = [];
	});

	const mount = async (el: ReactNode) => {
		root = createRoot(container);
		await act(async () => {
			root?.render(el);
		});
	};

	test("a ui part renders inline, never inside the Worked fold", async () => {
		const bashPart = {
			type: "tool-bash",
			toolCallId: "b1",
			state: "output-available",
			input: { command: "ls" },
			output: { exit_code: 0, output: "" },
		} as unknown as UIMessage["parts"][number];
		const ui = uiPart({
			state: "output-available",
			input: { blocks: [{ type: "text", md: "the interface" }] },
			output: "shown",
		}) as unknown as UIMessage["parts"][number];
		await mount(<MessageParts parts={[bashPart, ui, { type: "text", text: "after" }]} />);
		expect(container.querySelector(".worked .ui")).toBeNull();
		expect(container.querySelector(".worked .tool-run")).not.toBeNull();
		expect(container.querySelector(".ui")).not.toBeNull();
	});

	test("the html frame is sandboxed and carries the injected CSP", async () => {
		const htmlBlock = fixture.blocks.find((b) => b.type === "html")!;
		await mount(
			<UiPart
				part={uiPart({
					state: "output-available",
					input: { blocks: [htmlBlock] },
					output: "shown",
				})}
			/>,
		);
		const frame = container.querySelector("iframe");
		expect(frame).not.toBeNull();
		expect(frame!.getAttribute("sandbox")).toBe("allow-scripts");
		const srcdoc = frame!.getAttribute("srcdoc") ?? "";
		expect(srcdoc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(
			true,
		);
		expect(srcdoc).toContain("default-src 'none'");
	});

	test("choices fire onAction with the [ui] message; busy disables them", async () => {
		const actions: string[] = [];
		const choiceBlock = fixture.blocks.find((b) => b.type === "choices")!;
		const input = { blocks: [choiceBlock] };
		await mount(
			<UiPart
				part={uiPart({ state: "output-available", input, output: "shown" })}
				onAction={(t) => actions.push(t)}
			/>,
		);
		const btn = container.querySelector<HTMLButtonElement>(".ui-choice")!;
		expect(btn.disabled).toBe(false);
		await act(async () => {
			btn.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
		});
		expect(actions).toEqual(["[ui] Road loop"]);

		// busy pins every action control — a tap mid-turn must not fork.
		await act(async () => {
			root?.render(
				<UiPart
					part={uiPart({ state: "output-available", input, output: "shown" })}
					onAction={(t) => actions.push(t)}
					busy={true}
				/>,
			);
		});
		const busyBtn = container.querySelector<HTMLButtonElement>(".ui-choice")!;
		expect(busyBtn.disabled).toBe(true);
		await act(async () => {
			busyBtn.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
		});
		expect(actions.length).toBe(1);
	});

	test("a form submit reports field=value pairs in order", async () => {
		const actions: string[] = [];
		const formBlock = fixture.blocks.find((b) => b.type === "form")!;
		await mount(
			<UiPart
				part={uiPart({
					state: "output-available",
					input: { blocks: [formBlock] },
					output: "shown",
				})}
				onAction={(t) => actions.push(t)}
			/>,
		);
		const distance = container.querySelector<HTMLInputElement>('.ui-field input[type="number"]')!;
		expect(distance.step).toBe("any");
		distance.value = "30.5";
		const form = container.querySelector<HTMLFormElement>("form.ui-form")!;
		expect(form.checkValidity()).toBe(true);
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".ui-submit")!.click();
		});
		expect(actions).toEqual(["[ui] Plan ride: distance=30.5, terrain=flat, notes="]);
	});

	test("a form's uncontrolled inputs never leak into the next tab at the same index", async () => {
		const actions: string[] = [];
		const tabbedForm = (tag: string) => ({
			type: "form",
			fields: [{ name: "amount", label: "Amount", kind: "number" }],
			submit: tag,
		});
		const input = {
			blocks: [
				{
					type: "tabs",
					tabs: [
						{ label: "A", blocks: [tabbedForm("Send A")] },
						{ label: "B", blocks: [tabbedForm("Send B")] },
					],
				},
			],
		};
		await mount(
			<UiPart
				part={uiPart({ state: "output-available", input, output: "shown" })}
				onAction={(t) => actions.push(t)}
			/>,
		);
		const aInput = container.querySelector<HTMLInputElement>('.ui-field input[type="number"]')!;
		aInput.value = "750";
		// Switch tabs — the same-index form must mount fresh, not
		// reuse A's DOM node and its typed value.
		await clickEl([...container.querySelectorAll("[role='tab']")][1] ?? null);
		const bInput = container.querySelector<HTMLInputElement>('.ui-field input[type="number"]')!;
		expect(bInput).not.toBe(aInput);
		expect(bInput.value).toBe("");
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".ui-submit")!.click();
		});
		expect(actions).toEqual(["[ui] Send B: amount="]);
	});

	// Note fences inside ui blocks get the transcript's note context —
	// token, project binding, in-app navigation — through every
	// container depth.
	const fence = '````note title="Ideas"\nfenced body\n````';
	const fakeNoteApi = (calls: { url: string; init: RequestInit | undefined }[]) => {
		installGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			const body =
				init?.method === "POST" && url === "/api/app/notes"
					? { id: "n-new", title: "Ideas", rev: 1, body: "stored" }
					: { notes: [] };
			return Promise.resolve(
				new win.Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				}) as unknown as Response,
			);
		});
	};
	const clickEl = async (el: Element | null) => {
		expect(el).not.toBeNull();
		await act(async () => {
			el!.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
		});
	};
	const drain = () =>
		act(async () => {
			await new Promise((r) => setTimeout(r, 250));
		});

	test("note fences at every depth carry token, project, and navigation", async () => {
		const calls: { url: string; init: RequestInit | undefined }[] = [];
		const opened: string[] = [];
		fakeNoteApi(calls);
		const ui = uiPart({
			state: "output-available",
			input: {
				blocks: [
					{ type: "text", md: fence },
					{ type: "callout", title: "c", md: fence },
					{ type: "steps", items: [{ title: "s", md: fence }] },
					{
						type: "tabs",
						tabs: [
							{ label: "t", blocks: [{ type: "text", md: fence }] },
							{ label: "u", blocks: [{ type: "text", md: "other tab" }] },
						],
					},
					{
						type: "columns",
						columns: [
							{ blocks: [{ type: "text", md: fence }] },
							{ blocks: [{ type: "text", md: "other col" }] },
						],
					},
				],
			},
			output: "shown",
		}) as unknown as UIMessage["parts"][number];
		await mount(
			<MessageParts
				parts={[ui]}
				token="tok-1"
				noteProjectId="p-1"
				onOpenNote={(id) => opened.push(id)}
			/>,
		);
		const cards = container.querySelectorAll(".note-card");
		expect(cards).toHaveLength(5);

		// Every card — text, callout, steps, tabs, columns — runs the
		// full flow with the context its container chain forwarded.
		for (const [i, card] of [...cards].entries()) {
			await clickEl(card.querySelector(".note-card-append"));
			await drain();
			const list = calls.filter((c) => c.url.startsWith("/api/app/notes?")).at(-1)!;
			expect((list.init?.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
			await clickEl(
				[...card.querySelectorAll("button")].find((b) => b.textContent?.includes("New note")) ??
					null,
			);
			await act(async () => {
				await new Promise((r) => setTimeout(r, 0));
			});
			const creates = calls.filter((c) => c.init?.method === "POST");
			expect(creates).toHaveLength(i + 1);
			const create = creates.at(-1)!;
			expect((create.init?.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
			expect(JSON.parse(String(create.init?.body))).toEqual({
				title: "Ideas",
				body: "fenced body",
				projectId: "p-1",
			});
			// The done link navigates in-app with the created id.
			await clickEl(card.querySelector(".note-card-status button"));
			expect(opened).toEqual(Array(i + 1).fill("n-new"));
		}
	});

	test("a streaming ui block's note fence gets the context too — token null sends no Authorization", async () => {
		const calls: { url: string; init: RequestInit | undefined }[] = [];
		const opened: string[] = [];
		fakeNoteApi(calls);
		const ui = uiPart({
			state: "input-streaming",
			input: { blocks: [{ type: "text", md: fence }] },
		}) as unknown as UIMessage["parts"][number];
		await mount(
			<MessageParts
				parts={[ui]}
				token={null}
				noteProjectId="p-1"
				onOpenNote={(id) => opened.push(id)}
			/>,
		);
		const card = container.querySelector(".note-card");
		expect(card).not.toBeNull();
		await clickEl(card!.querySelector(".note-card-append"));
		await drain();
		await clickEl(
			[...card!.querySelectorAll("button")].find((b) => b.textContent?.includes("New note")) ??
				null,
		);
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		const create = calls.find((c) => c.init?.method === "POST")!;
		expect((create.init?.headers as Record<string, string>).authorization).toBeUndefined();
		expect(JSON.parse(String(create.init?.body)).projectId).toBe("p-1");
		await clickEl(card!.querySelector(".note-card-status button"));
		expect(opened).toEqual(["n-new"]);
	});

	test("a checkbox/textarea/date form submits true/false, text and raw date", async () => {
		const actions: string[] = [];
		await mount(
			<UiPart
				part={uiPart({
					state: "output-available",
					input: {
						blocks: [
							{
								type: "form",
								fields: [
									{ name: "water", label: "Water (2L)", kind: "checkbox" },
									{ name: "tent", label: "Tent", kind: "checkbox" },
									{ name: "notes", label: "Notes", kind: "textarea" },
									{ name: "leave", label: "Leave on", kind: "date" },
								],
								submit: "Done packing",
							},
						],
					},
					output: "shown",
				})}
				onAction={(t) => actions.push(t)}
			/>,
		);
		const boxes = container.querySelectorAll<HTMLInputElement>('.ui-field input[type="checkbox"]');
		expect(boxes.length).toBe(2);
		boxes[0]!.checked = true;
		container.querySelector<HTMLTextAreaElement>(".ui-field textarea")!.value = "headlamp";
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".ui-submit")!.click();
		});
		// The checkbox rides the same [ui] line as everything else —
		// .checked, not the inert "on" default value.
		expect(actions).toEqual(["[ui] Done packing: water=true, tent=false, notes=headlamp, leave="]);
	});

	// A note fence inside a ui block writes like one in reply text —
	// same bearer, same project binding, or the click 401s / files the
	// note loose in bearer mode and trust mode respectively.
	test("a note card inside a ui block carries the transcript's auth and project", async () => {
		const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const headers = new Headers(init?.headers);
			seen.push({
				url,
				auth: headers.get("authorization"),
				body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
			});
			if (init?.method === "POST")
				return Promise.resolve(
					new Response(JSON.stringify({ id: "n9", title: "scratch" }), {
						headers: { "content-type": "application/json" },
					}),
				);
			return Promise.resolve(
				new Response(JSON.stringify({ notes: [], truncated: false }), {
					headers: { "content-type": "application/json" },
				}),
			);
		}) as typeof fetch;
		try {
			const input = {
				blocks: [{ type: "text", md: "summary\n\n```note\nui-block body\n```" }],
			};
			await mount(
				<UiPart
					part={uiPart({ state: "output-available", input, output: "shown" })}
					token="tok-1"
					noteProjectId="proj-9"
				/>,
			);
			// The card renders inside the ui surface — not in reply text.
			const card = container.querySelector(".ui-text .note-card");
			expect(card).not.toBeNull();
			await act(async () => {
				card!
					.querySelector<HTMLButtonElement>(".note-card-append")!
					.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
			});
			const create = [...container.querySelectorAll<HTMLButtonElement>(".note-pick button")].find(
				(b) => b.textContent === "New note",
			)!;
			await act(async () => {
				create.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
			});
			const post = seen.find((s) => s.url === "/api/app/notes" && s.body !== undefined);
			expect(post?.auth).toBe("Bearer tok-1");
			expect(post?.body).toMatchObject({ projectId: "proj-9", body: "ui-block body" });
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("a choices tap highlights the matching table row; reload re-derives it", async () => {
		const input = {
			blocks: [
				{
					type: "table",
					columns: ["Ride", "km"],
					rows: [
						["Road loop", "42"],
						["Gravel trail", "60"],
					],
				},
				{
					type: "choices",
					prompt: "Which ride?",
					options: [{ label: "Road loop" }, { label: "Gravel trail" }],
				},
			],
		};
		const actions: string[] = [];
		await mount(
			<UiPart
				part={uiPart({ state: "output-available", input, output: "shown" })}
				onAction={(t) => actions.push(t)}
			/>,
		);
		expect(container.querySelector("tr.picked")).toBeNull();
		await act(async () => {
			container
				.querySelector<HTMLButtonElement>(".ui-choice")!
				.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
		});
		// The tap posts the ordinary [ui] message AND highlights locally.
		expect(actions).toEqual(["[ui] Road loop"]);
		expect(container.querySelector("tr.picked")?.textContent).toBe("Road loop42");

		// Reload: fresh mount with no tap — the highlight re-derives from
		// the persisted [ui] message.
		await act(async () => {
			root?.unmount();
			root = null;
		});
		const messages: UIMessage[] = [
			{ id: "m1", role: "user", parts: [{ type: "text", text: "[ui] Gravel trail" }] },
		];
		await mount(
			<UiPart
				part={uiPart({ state: "output-available", input, output: "shown" })}
				messages={messages}
			/>,
		);
		expect(container.querySelector("tr.picked")?.textContent).toBe("Gravel trail60");
	});
});
