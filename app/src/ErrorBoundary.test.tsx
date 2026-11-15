import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

// The root boundary's contract (#281): a child that throws during
// render is replaced by the fallback — role="alert", the message, a
// reload button — instead of a blank tree, and the failure is reported
// through componentDidCatch's console line.

describe("ErrorBoundary", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	const realError = console.error;
	const logged: unknown[][] = [];
	const globals = new Map<string, PropertyDescriptor | undefined>();

	beforeEach(() => {
		win = new Window({ url: "http://localhost/app/" });
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		logged.length = 0;
		// Silenced and captured: the boundary's own report plus anything
		// React itself logs for the caught error.
		console.error = (...args: unknown[]) => {
			logged.push(args);
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
	});

	afterEach(async () => {
		await act(async () => {
			root?.unmount();
		});
		root = null;
		console.error = realError;
		for (const [name, descriptor] of globals) {
			if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
			else Object.defineProperty(globalThis, name, descriptor);
		}
		globals.clear();
		await win.happyDOM.close();
	});

	test("a render throw shows the fallback instead of a blank tree", async () => {
		function Bomb(): never {
			throw new Error("skew kind has no defaults");
		}
		await act(async () => {
			root = createRoot(container);
			root.render(
				<ErrorBoundary>
					<Bomb />
				</ErrorBoundary>,
			);
		});
		const alert = container.querySelector('[role="alert"]');
		expect(alert).not.toBeNull();
		expect(alert?.className).toBe("error-boundary");
		expect(alert?.querySelector("p")?.textContent).toBe(
			"Something went wrong. The page hit an error it could not draw.",
		);
		expect(alert?.querySelector("pre")?.textContent).toBe("skew kind has no defaults");
		const reload = [...(alert?.querySelectorAll("button") ?? [])].find(
			(b) => b.textContent === "Reload",
		);
		expect(reload).toBeTruthy();
		// The report path: one "render failed" line carrying the error
		// and its component stack.
		const reported = logged.filter((a) => a[0] === "render failed");
		expect(reported).toHaveLength(1);
		expect((reported[0]?.[1] as Error).message).toBe("skew kind has no defaults");
		expect(reported[0]?.[2]).toBeTruthy();
	});
});
