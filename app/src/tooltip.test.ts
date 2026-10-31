// Tooltip contract: `title=` stays in the markup untouched; on hover or
// focus the hint text moves into the shared bubble (styled, so the
// native box never appears), positions above the host — flipping below
// and clamping at the viewport edge — and the attribute is restored
// when the hint ends. Inner crossings, scrolls, presses, and blurs all
// end it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installTooltips } from "./tooltip.ts";

let win: Window;
let doc: Document;
let uninstall: (() => void) | null = null;
let installed: string[] = [];

const installGlobal = (name: string, value: unknown) => {
	Reflect.set(globalThis, name, value);
	installed.push(name);
};

beforeEach(() => {
	win = new Window();
	doc = win.document as unknown as Document;
	installed = [];
	installGlobal("window", win);
	installGlobal("document", doc);
	installGlobal("Event", win.Event);
	installGlobal("MouseEvent", win.MouseEvent);
	installGlobal("FocusEvent", win.FocusEvent);
	uninstall = installTooltips(doc);
});

afterEach(async () => {
	uninstall?.();
	uninstall = null;
	await win.happyDOM.close();
	for (const name of installed) Reflect.deleteProperty(globalThis, name);
	installed = [];
});

const host = (title = "the hint"): HTMLElement => {
	const el = doc.createElement("button");
	el.setAttribute("title", title);
	doc.body.appendChild(el);
	return el as unknown as HTMLElement;
};

const tip = () => doc.querySelector(".tooltip");

const over = (el: Element) =>
	el.dispatchEvent(new win.MouseEvent("mouseover", { bubbles: true }) as unknown as Event);

const leave = (el: Element, to: Element | null = null) =>
	el.dispatchEvent(
		// happy-dom's MouseEventInit wants its own EventTarget class, not
		// the DOM lib's — go through a neutral signature so the cast is
		// version-proof either way.
		new (win.MouseEvent as unknown as new (t: string, i: object) => Event)("mouseout", {
			bubbles: true,
			relatedTarget: to ?? doc.body,
		}),
	);

describe("tooltip", () => {
	test("hover moves the hint into the bubble and back out", () => {
		const el = host();
		over(el);

		expect(el.getAttribute("title")).toBeNull();
		expect(tip()?.textContent).toBe("the hint");
		expect(tip()?.classList.contains("on")).toBe(true);

		leave(el);
		expect(el.getAttribute("title")).toBe("the hint");
		expect(tip()?.classList.contains("on")).toBe(false);
	});

	test("an empty or absent title never engages", () => {
		over(host(""));
		expect(tip()?.classList.contains("on")).toBe(false);
		over(doc.createElement("div"));
		expect(tip()?.classList.contains("on")).toBe(false);
	});

	test("an inner crossing keeps the hint", () => {
		const el = host();
		const child = doc.createElement("span");
		el.appendChild(child);
		over(el);
		expect(tip()?.classList.contains("on")).toBe(true);

		leave(child, el);
		expect(tip()?.classList.contains("on")).toBe(true);
		expect(el.getAttribute("title")).toBeNull();
	});

	test("focus shows it too; blur restores the attribute", () => {
		const el = host();
		el.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
		expect(tip()?.classList.contains("on")).toBe(true);
		expect(el.getAttribute("title")).toBeNull();

		el.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
		expect(tip()?.classList.contains("on")).toBe(false);
		expect(el.getAttribute("title")).toBe("the hint");
	});

	test("scroll, pointerdown, and nested hosts all end the current hint", () => {
		const first = host("first");
		over(first);
		doc.dispatchEvent(new win.Event("scroll") as unknown as Event);
		expect(first.getAttribute("title")).toBe("first");
		expect(tip()?.classList.contains("on")).toBe(false);

		over(first);
		doc.dispatchEvent(new win.MouseEvent("pointerdown", { bubbles: true }) as unknown as Event);
		expect(tip()?.classList.contains("on")).toBe(false);

		// Moving straight to a second titled element swaps hosts — and
		// restores the first host's attribute on the way.
		const second = host("second");
		over(first);
		over(second);
		expect(first.getAttribute("title")).toBe("first");
		expect(second.getAttribute("title")).toBeNull();
		expect(tip()?.textContent).toBe("second");
	});

	test("zero layout pins the flip math: below the host, inside the margin", () => {
		const el = host();
		over(el);
		const bubble = tip() as HTMLElement | null;
		if (bubble === null) throw new Error("no bubble");
		// happy-dom rects and offsets read zero: top = 0-0-7 flips below to
		// 0+7; left clamps up to the 4px viewport margin.
		expect(bubble.style.top).toBe("7px");
		expect(bubble.style.left).toBe("4px");
	});
});
