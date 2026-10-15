// useCopy's contract is a button label in a live DOM — mounted with
// happy-dom like Composer.test.tsx. navigator.clipboard is the
// boundary under test: each case stubs it to resolve, reject, throw
// synchronously, or be absent entirely.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { useCopy } from "./useCopy.ts";
import { CopyBtn } from "./tools/bits.tsx";
import { Markdown } from "./markdown.tsx";

function Probe() {
	const { copied, failed, copy } = useCopy();
	return (
		<button type="button" onClick={() => copy("payload")}>
			{failed ? "✗" : copied ? "✓" : "copy"}
		</button>
	);
}

describe("useCopy", () => {
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

	const stubClipboard = (clipboard: unknown) => {
		Object.defineProperty(win.navigator, "clipboard", { value: clipboard, configurable: true });
	};

	const mount = async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(<Probe />);
		});
	};

	const button = () => {
		const btn = container.querySelector("button");
		expect(btn).not.toBeNull();
		return btn!;
	};

	const click = async () => {
		await act(async () => {
			button().dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
		});
	};

	test("a resolved write shows the copied state, then reverts", async () => {
		const writes: string[] = [];
		stubClipboard({ writeText: (t: string) => (writes.push(t), Promise.resolve()) });
		await mount();
		await click();
		expect(button().textContent).toBe("✓");
		expect(writes).toEqual(["payload"]);
		// The ✓ is a moment of feedback, not a new resting state.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 1700));
		});
		expect(button().textContent).toBe("copy");
	});

	test("a rejected write shows the failed state", async () => {
		stubClipboard({ writeText: () => Promise.reject(new Error("denied")) });
		await mount();
		await click();
		expect(button().textContent).toBe("✗");
	});

	test("code and tool copy buttons expose an accessible, visible rejection", async () => {
		stubClipboard({ writeText: () => Promise.reject(new Error("denied")) });
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<>
					<CopyBtn text="tool output" />
					<Markdown text={"```text\ncode output\n```"} />
				</>,
			),
		);
		const buttons = [...container.querySelectorAll("button")];
		expect(buttons).toHaveLength(2);
		for (const copyButton of buttons) {
			await act(async () => copyButton.click());
			expect(copyButton.textContent).toBe("copy failed");
			expect(copyButton.getAttribute("aria-label")).toBe("Copy failed");
			expect(copyButton.getAttribute("aria-live")).toBe("polite");
		}
	});

	test("a synchronously throwing write shows the failed state", async () => {
		stubClipboard({
			writeText: () => {
				throw new Error("denied");
			},
		});
		await mount();
		await click();
		expect(button().textContent).toBe("✗");
	});

	test("no clipboard API at all (non-secure context) shows the failed state", async () => {
		stubClipboard(undefined);
		await mount();
		await click();
		expect(button().textContent).toBe("✗");
	});

	test("the newest click wins — a stale write resolving late keeps the newer verdict", async () => {
		let release!: () => void;
		const held = new Promise<void>((res) => {
			release = res;
		});
		let calls = 0;
		stubClipboard({
			writeText: () => (calls++ === 0 ? held : Promise.reject(new Error("denied"))),
		});
		await mount();
		// First write stays in flight; a second click fails before it lands.
		await click();
		await click();
		expect(button().textContent).toBe("✗");
		await act(async () => {
			release();
			await held;
		});
		expect(button().textContent).toBe("✗");
	});
});
