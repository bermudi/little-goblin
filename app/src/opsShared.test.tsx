// useLoad's contract: a successful (re)load clears the error an
// earlier attempt left behind — the err-first views (SkillsView & co.)
// would otherwise stay on the error page after a recovery — and a
// stale in-flight load must never land over a newer one.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { ApiError } from "./api.ts";
import { useLoad } from "./opsShared.tsx";

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	win = new Window({ url: "http://localhost/app" });
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
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
	await act(async () => root?.unmount());
	root = null;
	await win.happyDOM.close();
	for (const [name, descriptor] of globals) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
		else Object.defineProperty(globalThis, name, descriptor);
	}
	globals.clear();
});

// The smallest consumer of the hook — data, error, and an
// always-present reload lever, the shape the err-first views ride on.
// The load function is injected; nothing reaches for the wire.
function Probe({ load }: { load: () => Promise<string> }) {
	const { data, err, reload } = useLoad(load);
	return (
		<>
			<span className="probe-data">{data ?? "—"}</span>
			{err !== null && <p className="error">{err}</p>}
			<button type="button" className="probe-reload" onClick={reload}>
				reload
			</button>
		</>
	);
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const data = () => container.querySelector(".probe-data")?.textContent;
const err = () => container.querySelector(".error")?.textContent ?? null;
const reload = () =>
	act(async () => {
		(container.querySelector(".probe-reload") as HTMLButtonElement).click();
	});

test("a successful reload clears the error a failed one left", async () => {
	let impl: () => Promise<string> = () => Promise.resolve("first");
	root = createRoot(container);
	await act(async () => {
		root?.render(<Probe load={() => impl()} />);
	});
	expect(data()).toBe("first");
	expect(err()).toBeNull();

	impl = () => Promise.reject(new ApiError(503, "store is busy"));
	await reload();
	expect(err()).toBe("store is busy");

	impl = () => Promise.resolve("recovered");
	await reload();
	expect(err()).toBeNull();
	expect(data()).toBe("recovered");
});

test("a failed initial load clears on reload too", async () => {
	let impl: () => Promise<string> = () => Promise.reject(new Error("offline"));
	root = createRoot(container);
	await act(async () => {
		root?.render(<Probe load={() => impl()} />);
	});
	expect(err()).toBe("Couldn't reach goblin — check the tailnet.");
	expect(data()).toBe("—");

	impl = () => Promise.resolve("up");
	await reload();
	expect(err()).toBeNull();
	expect(data()).toBe("up");
});

test("an outdated rejection can't resurrect an error a newer load cleared", async () => {
	const stale = deferred<string>();
	let impl: () => Promise<string> = () => Promise.resolve("first");
	root = createRoot(container);
	await act(async () => {
		root?.render(<Probe load={() => impl()} />);
	});

	// Two reloads overlap: the newer one lands first, so the older
	// load's late rejection is dead on arrival.
	impl = () => stale.promise;
	await reload();
	impl = () => Promise.resolve("newer");
	await reload();
	expect(data()).toBe("newer");
	expect(err()).toBeNull();

	await act(async () => {
		stale.reject(new ApiError(500, "late boom"));
	});
	expect(err()).toBeNull();
	expect(data()).toBe("newer");
});
