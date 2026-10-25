// Outline contract: one dash per operator message (assistant turns are
// not sections), titles come from the message's first text line with a
// kind fallback for media-only sends, a click jumps the transcript to the
// section, and the scroll spy marks the section in view. The DOM is real
// (happy-dom); only per-element layout rects are stubbed, which is the
// layout engine's job, not the component's.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRef } from "react";
import { Outline, outlineTitle } from "./Outline.tsx";

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
	installGlobal("Event", win.Event);
	installGlobal("MouseEvent", win.MouseEvent);
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
	for (const name of installed) Reflect.deleteProperty(globalThis, name);
	installed = [];
	Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const settle = async () => {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 10));
	});
};

const msg = (id: string, role: UIMessage["role"], text?: string): UIMessage =>
	({
		id,
		role,
		parts: text === undefined ? [] : [{ type: "text", text }],
	}) as UIMessage;

// Mirrors ChatView's mounting contract: anchors carry data-outline-anchor
// on the message row, the Outline shares the transcript's scroll ref.
function Harness({ messages }: { messages: UIMessage[] }) {
	const ref = useRef<HTMLDivElement | null>(null);
	return (
		<div ref={ref} className="transcript">
			<div className="transcript-inner">
				{messages.map((m) => (
					<div
						key={m.id}
						className={`msg ${m.role}`}
						data-outline-anchor={m.role === "user" ? m.id : undefined}
					/>
				))}
			</div>
			<Outline messages={messages} scrollRef={ref} />
		</div>
	);
}

const mount = async (messages: UIMessage[]) => {
	root = createRoot(container);
	await act(async () => {
		root?.render(<Harness messages={messages} />);
	});
	await settle();
};

const entries = (): HTMLButtonElement[] => [
	...container.querySelectorAll<HTMLButtonElement>(".outline button"),
];

describe("outlineTitle", () => {
	test("first line of text wins", () => {
		expect(outlineTitle(msg("a", "user", "first question\nsecond line"))).toBe("first question");
	});

	test("media-only sends fall back to the staged chip kind", () => {
		const file = { type: "file", mediaType: "image/png" } as unknown as UIMessage["parts"][number];
		const note = { type: "data-note", data: {} } as unknown as UIMessage["parts"][number];
		const skill = { type: "data-skill", data: {} } as unknown as UIMessage["parts"][number];
		expect(outlineTitle({ id: "a", role: "user", parts: [file] } as UIMessage)).toBe("attachment");
		expect(outlineTitle({ id: "b", role: "user", parts: [note] } as UIMessage)).toBe("note");
		expect(outlineTitle({ id: "c", role: "user", parts: [skill] } as UIMessage)).toBe("skill");
		expect(outlineTitle(msg("d", "user"))).toBe("message");
	});
});

describe("Outline", () => {
	test("one entry per operator message, none for replies", async () => {
		await mount([
			msg("u1", "user", "first"),
			msg("a1", "assistant", "answer"),
			msg("u2", "user", "second"),
		]);
		const buttons = entries();
		expect(buttons.length).toBe(2);
		expect(buttons[0]?.getAttribute("aria-label")).toBe("Jump: first");
		expect(buttons[1]?.getAttribute("aria-label")).toBe("Jump: second");
	});

	test("no sections, no rail", async () => {
		await mount([msg("a1", "assistant", "answer")]);
		expect(container.querySelector(".outline")).toBeNull();
	});

	test("a click jumps the transcript to the section, headroom included", async () => {
		await mount([msg("u1", "user", "first"), msg("u2", "user", "second")]);
		const transcript = container.querySelector<HTMLElement>(".transcript");
		if (transcript === null) throw new Error("no transcript");
		transcript.scrollTop = 100;
		// happy-dom rects read zero, so the jump's arithmetic is exactly
		// what the assertion pins: target(0) − container(0) − headroom(12).
		await act(async () => {
			entries()[1]?.dispatchEvent(
				new win.MouseEvent("click", { bubbles: true }) as unknown as Event,
			);
		});
		expect(transcript.scrollTop).toBe(88);
	});

	test("the scroll spy marks the section in view", async () => {
		await mount([msg("u1", "user", "first"), msg("u2", "user", "second")]);
		const transcript = container.querySelector<HTMLElement>(".transcript");
		if (transcript === null) throw new Error("no transcript");
		const anchors = [...transcript.querySelectorAll<HTMLElement>("[data-outline-anchor]")];
		const [first, second] = anchors;
		if (first === undefined || second === undefined) throw new Error("missing anchors");
		first.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
		second.getBoundingClientRect = () => ({ top: -50 }) as DOMRect;
		transcript.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;

		await act(async () => {
			transcript.dispatchEvent(new win.Event("scroll") as unknown as Event);
		});
		await settle();

		expect(entries()[0]?.getAttribute("aria-current")).toBeNull();
		expect(entries()[1]?.getAttribute("aria-current")).toBe("true");
	});

	test("above every section nothing is current", async () => {
		await mount([msg("u1", "user", "first")]);
		const transcript = container.querySelector<HTMLElement>(".transcript");
		if (transcript === null) throw new Error("no transcript");
		const anchor = transcript.querySelector<HTMLElement>("[data-outline-anchor]");
		if (anchor === null) throw new Error("no anchor");
		anchor.getBoundingClientRect = () => ({ top: 500 }) as DOMRect;
		transcript.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;

		await act(async () => {
			transcript.dispatchEvent(new win.Event("scroll") as unknown as Event);
		});
		await settle();

		expect(entries()[0]?.getAttribute("aria-current")).toBeNull();
	});

	test("stream-chunk re-renders keep the spy; a changed section set re-runs it", async () => {
		await mount([msg("u1", "user", "first"), msg("a1", "assistant", "answer")]);
		const transcript = container.querySelector<HTMLElement>(".transcript");
		if (transcript === null) throw new Error("no transcript");
		// Each effect run re-registers the scroll listener — counting
		// "scroll" adds counts measure()s, which is what must not happen
		// per stream chunk.
		let adds = 0;
		const add = transcript.addEventListener.bind(transcript);
		Object.defineProperty(transcript, "addEventListener", {
			value: (type: string, listener: EventListenerOrEventListenerObject) => {
				if (type === "scroll") adds += 1;
				return add(type, listener);
			},
		});

		// A streaming assistant turn: fresh messages array, same anchors.
		await act(async () => {
			root?.render(
				<Harness
					messages={[msg("u1", "user", "first"), msg("a1", "assistant", "longer answer")]}
				/>,
			);
		});
		await settle();
		expect(adds).toBe(0);

		// A new operator message changes the section set — re-measure.
		await act(async () => {
			root?.render(
				<Harness
					messages={[
						msg("u1", "user", "first"),
						msg("a1", "assistant", "longer answer"),
						msg("u2", "user", "second"),
					]}
				/>,
			);
		});
		await settle();
		expect(adds).toBe(1);
		expect(entries().length).toBe(2);
	});

	test("the spy re-measures on relayout, no scroll event needed", async () => {
		// happy-dom's ResizeObserver never fires; record the registrations
		// so the test can play one relayout by hand.
		const callbacks: Array<() => void> = [];
		class RecordingObserver {
			constructor(callback: () => void) {
				callbacks.push(callback);
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		}
		Reflect.set(win, "ResizeObserver", RecordingObserver);

		await mount([msg("u1", "user", "first"), msg("u2", "user", "second")]);
		expect(callbacks.length).toBeGreaterThan(0);
		const transcript = container.querySelector<HTMLElement>(".transcript");
		if (transcript === null) throw new Error("no transcript");
		const anchors = [...transcript.querySelectorAll<HTMLElement>("[data-outline-anchor]")];
		const [first, second] = anchors;
		if (first === undefined || second === undefined) throw new Error("missing anchors");
		// At mount the zero rects made the last section current; after the
		// relayout only the first section sits above the quarter mark.
		expect(entries()[1]?.getAttribute("aria-current")).toBe("true");
		first.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
		second.getBoundingClientRect = () => ({ top: 500 }) as DOMRect;
		transcript.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;

		await act(async () => {
			for (const callback of callbacks) callback();
		});
		await settle();

		expect(entries()[0]?.getAttribute("aria-current")).toBe("true");
		expect(entries()[1]?.getAttribute("aria-current")).toBeNull();
	});
});
