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
	let installed: string[] = [];

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
		for (const name of installed) Reflect.deleteProperty(globalThis, name);
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

});
