// Tooltip contract: on hover or focus `title=` is temporarily emptied
// and the hint moves into the shared bubble (styled, so the native box
// never appears), positioned above the host — flipping below and clamping
// at the viewport edge. It is restored on dismissal unless changed while
// open. Inner crossings keep it; scrolls, presses, and blurs end it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
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

		expect(el.getAttribute("title")).toBe("");
		expect(tip()?.textContent).toBe("the hint");
		expect(tip()?.classList.contains("on")).toBe(true);

		leave(el);
		expect(el.getAttribute("title")).toBe("the hint");
		expect(tip()?.classList.contains("on")).toBe(false);
	});

	test("a title updated while the hint is open survives dismissal", () => {
		const el = host("old");
		over(el);
		el.setAttribute("title", "new");
		leave(el);
		expect(el.getAttribute("title")).toBe("new");
		over(el);
		expect(tip()?.textContent).toBe("new");
	});

	test("a title removed while the hint is open stays removed, even on immediate dismissal", () => {
		const el = host("old");
		over(el);
		el.removeAttribute("title");
		leave(el);
		expect(el.hasAttribute("title")).toBe(false);
	});

	test("React removing a title during hover does not resurrect it", async () => {
		installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const container = doc.createElement("div");
		doc.body.appendChild(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(createElement("button", { title: "old" }, "button")));
			const el = container.querySelector("button");
			if (el === null) throw new Error("button missing");
			over(el);
			await act(async () => root.render(createElement("button", { title: undefined }, "button")));
			leave(el);
			expect(el.hasAttribute("title")).toBe(false);
		} finally {
			await act(async () => root.unmount());
		}
	});

	test("a title explicitly cleared while the hint is open stays empty", async () => {
		const el = host("old");
		over(el);
		el.setAttribute("title", "");
		await Promise.resolve();
		leave(el);
		expect(el.getAttribute("title")).toBe("");
	});

	test("an empty or absent title never engages", () => {
		over(host(""));
		expect(tip()?.classList.contains("on")).toBe(false);
		over(doc.createElement("div"));
		expect(tip()?.classList.contains("on")).toBe(false);
	});

	test("a hint repeating the host's visible text is suppressed unless clipped", () => {
		const el = doc.createElement("span");
		el.textContent = "win % probability?";
		el.setAttribute("title", "win % probability?");
		doc.body.appendChild(el);
		over(el);
		expect(tip()?.classList.contains("on")).toBe(false);

		// Same text, now ellipsized: the tip earns its keep.
		Object.defineProperty(el, "scrollWidth", { value: 200, configurable: true });
		Object.defineProperty(el, "clientWidth", { value: 100, configurable: true });
		over(el);
		expect(tip()?.classList.contains("on")).toBe(true);
	});

	test("an inner crossing keeps the hint", () => {
		const el = host();
		const child = doc.createElement("span");
		el.appendChild(child);
		over(el);
		expect(tip()?.classList.contains("on")).toBe(true);

		leave(child, el);
		expect(tip()?.classList.contains("on")).toBe(true);
		expect(el.getAttribute("title")).toBe("");
	});

	test("focus shows it too; blur restores the attribute", () => {
		const el = host();
		el.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
		expect(tip()?.classList.contains("on")).toBe(true);
		expect(el.getAttribute("title")).toBe("");

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
		expect(second.getAttribute("title")).toBe("");
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
