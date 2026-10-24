// UiPart render contract: complete inputs render the element tree,
// partial inputs render what has arrived with skeletons for pending
// ids (tail-only) and orphans in arrival order until root lands, bad
// payloads — legacy {blocks} included — fall back to the generic tool
// row, never a blank.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { ToolUIPart, UIMessage } from "ai";
import fixture from "../../../src/agent/tools/testdata/ui-all-elements.json" with { type: "json" };
import { MessageParts } from "../ChatView.tsx";
import { UiPart } from "./UiPart.tsx";

function uiPart(p: Record<string, unknown>): ToolUIPart {
	return { type: "tool-ui", toolCallId: "u1", ...p } as unknown as ToolUIPart;
}

const els = fixture.elements as Record<string, unknown>;
const pick = (...ids: string[]) =>
	Object.fromEntries(ids.map((id) => [id, els[id]])) as typeof els;

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
			"stack",
			"html",
		]) {
			expect(html, `missing ui-${kind}`).toContain(`ui-${kind}`);
		}
	});

	test("a deeply nested spec renders tabs > columns > steps", () => {
		const input = {
			root: "s",
			elements: {
				s: { type: "stack", children: ["t"] },
				t: { type: "tabs", children: ["a", "b"] },
				a: { type: "tab", props: { label: "A" }, children: ["c"] },
				b: { type: "tab", props: { label: "B" }, children: ["bx"] },
				c: { type: "columns", children: ["c1", "c2"] },
				c1: { type: "column", children: ["st"] },
				c2: { type: "column", children: ["x2"] },
				st: { type: "steps", props: { items: [{ title: "one" }] } },
				bx: { type: "text", props: { md: "second" } },
				x2: { type: "text", props: { md: "deep" } },
			},
		};
		const html = renderToStaticMarkup(
			<UiPart part={uiPart({ state: "output-available", input, output: "shown" })} />,
		);
		expect(html).toContain("ui-tabs");
		expect(html).toContain("ui-columns");
		expect(html).toContain("ui-steps");
		expect(html).toContain("deep");
	});

	test("input-streaming skeletons pending child ids and a tail fragment", () => {
		const html = renderToStaticMarkup(
			<UiPart
				part={uiPart({
					state: "input-streaming",
					input: {
						root: "s",
						elements: {
							s: { type: "stack", children: ["a", "b"] },
							a: { type: "text", props: { md: "done element" } },
							b: { type: "table" }, // tail, still writing
						},
					},
				})}
			/>,
		);
		expect(html).toContain("done element");
		expect(html).not.toContain("ui-table");
		expect(html.match(/skel skel-a/g)?.length).toBe(1);
	});

	test("input-streaming: an invalid non-tail renders nothing", () => {
		const html = renderToStaticMarkup(
			<UiPart
				part={uiPart({
					state: "input-streaming",
					input: {
						root: "s",
						elements: {
							s: { type: "stack", children: ["bad", "a"] },
							bad: { type: "frobnicate" },
							a: { type: "text", props: { md: "kept" } },
						},
					},
				})}
			/>,
		);
		expect(html).toContain("kept");
		expect(html).not.toContain("skel");
	});

	test("input-streaming: missing child ids skeleton even when invalid", () => {
		const html = renderToStaticMarkup(
			<UiPart
				part={uiPart({
					state: "input-streaming",
					input: {
						root: "s",
						elements: { s: { type: "stack", children: ["pending"] } },
					},
				})}
			/>,
		);
		expect(html).toContain("skel");
	});

	test("input-streaming without root renders orphans in arrival order", () => {
		const html = renderToStaticMarkup(
			<UiPart
				part={uiPart({
					state: "input-streaming",
					input: {
						elements: {
							first: { type: "text", props: { md: "aaa" } },
							parent: { type: "stack", children: ["first"] },
							second: { type: "text", props: { md: "bbb" } },
						},
					},
				})}
			/>,
		);
		// "parent" holds "first" — single orphan after normalize? No:
		// "second" is also unreferenced → two orphans → no inferred root.
		// Arrival order: first (referenced? no — referenced by parent!)
		// so orphans = parent, second → parent's subtree then second.
		const ia = html.indexOf("aaa");
		const ib = html.indexOf("bbb");
		expect(ia).toBeGreaterThan(-1);
		expect(ib).toBeGreaterThan(-1);
		expect(ia).toBeLessThan(ib);
	});

	test("input-streaming with a cyclic partial input does not hang", () => {
		const html = renderToStaticMarkup(
			<UiPart
				part={uiPart({
					state: "input-streaming",
					input: {
						root: "a",
						elements: {
							a: { type: "stack", children: ["b"] },
							b: { type: "stack", children: ["a"] },
						},
					},
				})}
			/>,
		);
		expect(html).toContain("ui-stack");
	});

	test("input-streaming never mounts an html iframe, nested or not", () => {
		for (const input of [
			{ root: "calc", elements: pick("calc") },
			{ root: "bytype", elements: pick("bytype", "tpros", "pros-t", "tcons", "cons-t", "cons-c") },
		]) {
			const html = renderToStaticMarkup(
				<UiPart part={uiPart({ state: "input-streaming", input })} />,
			);
			expect(html).not.toContain("<iframe");
		}
	});

	test("a legacy {blocks} part falls back to the generic tool row", () => {
		const html = renderToStaticMarkup(
			<UiPart
				part={uiPart({
					state: "output-available",
					input: { title: "old", blocks: [{ type: "text", md: "hi" }] },
					output: "shown",
				})}
			/>,
		);
		expect(html).toContain("tool-run");
		expect(html).toContain(">ui</span>");
	});

	test("a schema-failing input falls back to the generic tool row", () => {
		const html = renderToStaticMarkup(
			<UiPart
				part={uiPart({
					state: "output-available",
					input: { root: "a", elements: { a: { type: "frobnicate" } } },
					output: "shown",
				})}
			/>,
		);
		expect(html).toContain("tool-run");
	});

	test("a streaming text element's unclosed note fence stays non-actionable", () => {
		const input = {
			root: "a",
			elements: { a: { type: "text", props: { md: "```note\npartial body" } } },
		};
		const streaming = renderToStaticMarkup(
			<UiPart part={uiPart({ state: "input-streaming", input })} />,
		);
		expect(streaming).toContain("note-card");
		expect(streaming).not.toContain("note-card-append");
		const settled = renderToStaticMarkup(
			<UiPart part={uiPart({ state: "output-available", input, output: "shown" })} />,
		);
		expect(settled).toContain("note-card-append");
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

	const clickEl = async (el: Element | null) => {
		expect(el).not.toBeNull();
		await act(async () => {
			el!.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
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
			input: { root: "a", elements: { a: { type: "text", props: { md: "the interface" } } } },
			output: "shown",
		}) as unknown as UIMessage["parts"][number];
		await mount(<MessageParts parts={[bashPart, ui, { type: "text", text: "after" }]} />);
		expect(container.querySelector(".worked .ui")).toBeNull();
		expect(container.querySelector(".worked .tool-run")).not.toBeNull();
		expect(container.querySelector(".ui")).not.toBeNull();
	});

	test("the html frame is sandboxed and carries the injected CSP", async () => {
		await mount(
			<UiPart
				part={uiPart({
					state: "output-available",
					input: { root: "calc", elements: pick("calc") },
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
		const input = { root: "pick", elements: pick("pick") };
		await mount(
			<UiPart
				part={uiPart({ state: "output-available", input, output: "shown" })}
				onAction={(t) => actions.push(t)}
			/>,
		);
		const btn = container.querySelector<HTMLButtonElement>(".ui-choice")!;
		expect(btn.disabled).toBe(false);
		await clickEl(btn);
		expect(actions).toEqual(["[ui] Road loop"]);

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
		await clickEl(busyBtn);
		expect(actions.length).toBe(1);
	});

	test("a form submit reports field=value pairs in order", async () => {
		const actions: string[] = [];
		await mount(
			<UiPart
				part={uiPart({
					state: "output-available",
					input: { root: "ride", elements: pick("ride") },
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

	test("streaming tabs stay switchable — the render closure keeps no per-pass state", async () => {
		// Regression: the streaming render's revisit guard used to live
		// in a Set captured by the render closure — a Tabs setState
		// re-render then saw already-visited ids and rendered null.
		const input = {
			root: "t",
			elements: {
				t: { type: "tabs", children: ["a", "b"] },
				a: { type: "tab", props: { label: "A" }, children: ["ax"] },
				b: { type: "tab", props: { label: "B" }, children: ["bx"] },
				ax: { type: "text", props: { md: "tab one body" } },
				bx: { type: "text", props: { md: "tab two body" } },
			},
		};
		await mount(<UiPart part={uiPart({ state: "input-streaming", input })} />);
		expect(container.textContent).toContain("tab one body");
		const tabs = () => [...container.querySelectorAll("[role='tab']")];
		await clickEl(tabs()[1] ?? null);
		expect(container.textContent).toContain("tab two body");
		await clickEl(tabs()[0] ?? null);
		expect(container.textContent).toContain("tab one body");
	});

	test("a form's uncontrolled inputs never leak into the next tab at the same index", async () => {
		const actions: string[] = [];
		const form = (tag: string) => ({
			type: "form",
			props: {
				fields: [{ name: "amount", label: "Amount", kind: "number" }],
				submit: tag,
			},
		});
		const input = {
			root: "t",
			elements: {
				t: { type: "tabs", children: ["a", "b"] },
				a: { type: "tab", props: { label: "A" }, children: ["fa"] },
				b: { type: "tab", props: { label: "B" }, children: ["fb"] },
				fa: form("Send A"),
				fb: form("Send B"),
			},
		};
		await mount(
			<UiPart
				part={uiPart({ state: "output-available", input, output: "shown" })}
				onAction={(t) => actions.push(t)}
			/>,
		);
		const aInput = container.querySelector<HTMLInputElement>('.ui-field input[type="number"]')!;
		aInput.value = "750";
		await clickEl([...container.querySelectorAll("[role='tab']")][1] ?? null);
		const bInput = container.querySelector<HTMLInputElement>('.ui-field input[type="number"]')!;
		expect(bInput).not.toBe(aInput);
		expect(bInput.value).toBe("");
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".ui-submit")!.click();
		});
		expect(actions).toEqual(["[ui] Send B: amount="]);
	});

	test("a checkbox/textarea/date form submits true/false, text and raw date", async () => {
		const actions: string[] = [];
		await mount(
			<UiPart
				part={uiPart({
					state: "output-available",
					input: { root: "pack", elements: pick("pack") },
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
		expect(actions).toEqual(["[ui] Done packing: water=true, tent=false, notes=headlamp, leave="]);
	});

	test("a choices tap highlights the matching table row; reload re-derives it", async () => {
		const input = {
			root: "main",
			elements: {
				main: { type: "stack", children: ["tbl", "pick"] },
				tbl: {
					type: "table",
					props: {
						columns: ["Ride", "km"],
						rows: [
							["Road loop", "42"],
							["Gravel trail", "60"],
						],
					},
				},
				...pick("pick"),
			},
		};
		const actions: string[] = [];
		await mount(
			<UiPart
				part={uiPart({ state: "output-available", input, output: "shown" })}
				onAction={(t) => actions.push(t)}
			/>,
		);
		const btn = [...container.querySelectorAll<HTMLButtonElement>(".ui-choice")].find(
			(b) => b.textContent === "Road loop",
		)!;
		await clickEl(btn);
		expect(actions).toEqual(["[ui] Road loop"]);
		const pickedRow = container.querySelector("tr.picked td");
		expect(pickedRow?.textContent).toBe("Road loop");
	});
});
