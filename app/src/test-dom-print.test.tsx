import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

// The preload (test-dom-print.ts) keeps failed assertions on happy-dom
// nodes bounded. Each test fails an assertion on purpose and checks the
// message bun would print. Without the preload these messages run to
// megabytes for one node, and with <App /> mounted the run dies (#798).

const BOUNDED = 2_000;

let win: Window;
let host: HTMLElement;
let root: Root;
const globals = new Map<string, PropertyDescriptor | undefined>();

function Row({ i }: { i: number }) {
	const [n, setN] = useState(i);
	return (
		<li className={`row r${n}`} data-row={n} onClick={() => setN(n + 1)}>
			<span>{`item ${n}`}</span>
			<button type="button">go</button>
		</li>
	);
}

beforeEach(async () => {
	win = new Window({ url: "http://localhost/app/" });
	for (const [name, value] of [
		["window", win],
		["document", win.document],
		["navigator", win.navigator],
		["IS_REACT_ACT_ENVIRONMENT", true],
	] as const) {
		globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Reflect.set(globalThis, name, value);
	}
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	host = div as unknown as HTMLElement;
	root = createRoot(host);
	await act(async () =>
		root.render(
			<ul>
				{Array.from({ length: 50 }, (_, i) => (
					<Row key={i} i={i} />
				))}
			</ul>,
		),
	);
});

afterEach(async () => {
	await act(async () => root.unmount());
	await win.happyDOM.close();
	for (const [name, descriptor] of globals) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
		else Object.defineProperty(globalThis, name, descriptor);
	}
	globals.clear();
});

async function failure(assertion: () => unknown): Promise<string> {
	try {
		await assertion();
	} catch (err) {
		return (err as Error).message;
	}
	throw new Error("the assertion passed; it was meant to fail");
}

function equal(received: unknown, expected: unknown): void {
	expect(received).toEqual(expected);
}

const row = () => host.querySelector(".row");

test("a node in Received: prints as one line of markup", async () => {
	const message = await failure(() => expect(row()).toBeNull());
	expect(message.length).toBeLessThan(BOUNDED);
	expect(message).toContain('Received: <li class="row r0" data-row="0">item 0go</li>');
});

test("text nodes, the document and the window print short", async () => {
	const text = row()!.querySelector("span")!.firstChild;
	expect(await failure(() => expect(text).toBeNull())).toContain('#text "item 0"');
	const doc = await failure(() => expect(win.document).toBeUndefined());
	expect(doc).toContain("#document (1 children)");
	const window = await failure(() => expect(win).toBeNull());
	expect(window.length).toBeLessThan(BOUNDED);
});

test("diff matchers refuse a node with a readable message", async () => {
	const node = row();
	const cases: [string, () => unknown][] = [
		["toEqual", () => expect({ rows: [node] }).toEqual({ rows: [] })],
		["toEqual", () => equal({ rows: [] }, { rows: [node] })],
		["toEqual", () => expect({ a: 1 }).not.toEqual({ a: node })],
		["toStrictEqual", () => expect(node).toStrictEqual(null)],
		["toMatchObject", () => expect({ el: node }).toMatchObject({ el: null })],
		["toHaveProperty", () => expect({ el: node }).toHaveProperty("el", 1)],
	];
	for (const [matcher, assertion] of cases) {
		const message = await failure(assertion);
		expect(message.length).toBeLessThan(BOUNDED);
		expect(message).toContain(`${matcher}() got a happy-dom node at `);
		expect(message).toContain('<li class="row r0" data-row="0">item 0go</li>');
	}
	expect(await failure(() => expect({ rows: [node] }).toEqual({ rows: [] }))).toContain(
		"at received.rows[0]",
	);
});

test("a node deep behind many objects is still refused", async () => {
	const message = await failure(() =>
		equal([row(), ...Array.from({ length: 10_010 }, () => ({}))], []),
	);
	expect(message.length).toBeLessThan(BOUNDED);
	expect(message).toContain("got a happy-dom node at received[0]");
});

test("the guard adds no assertions", () => {
	expect.assertions(2);
	expect({ a: 1 }).toEqual({ a: 1 });
	expect([1]).toStrictEqual([1]);
});

test("proxies are compared, not walked", () => {
	const proxy = new Proxy(
		{ a: 1 },
		{
			ownKeys() {
				throw new Error("unexpected ownKeys");
			},
		},
	);
	expect(proxy).toEqual(proxy);
});

test("mock-call matchers refuse a node passed to the mock", async () => {
	const onPick = mock((_el: unknown) => {});
	onPick(row());
	for (const assertion of [
		() => expect(onPick).toHaveBeenCalledWith(null),
		() => expect(onPick).toHaveBeenLastCalledWith(null),
		() => expect(onPick).toHaveBeenNthCalledWith(1, null),
	]) {
		const message = await failure(assertion);
		expect(message.length).toBeLessThan(BOUNDED);
		expect(message).toContain("got a happy-dom node at received.mock.calls[0][0]");
	}
});

test("assertions without a node keep bun's own messages", async () => {
	const message = await failure(() => expect({ a: 1 }).toEqual({ a: 2 }));
	expect(message).toContain("- Expected  - 1");
	expect({ texts: [row()?.textContent] }).toEqual({ texts: ["item 0go"] });
	// A node elsewhere in the object is not what toHaveProperty prints.
	expect({ el: row(), n: 1 }).toHaveProperty("n", 1);
	const onPick = mock((_n: number) => {});
	onPick(1);
	expect(onPick).toHaveBeenCalledWith(1);
	await expect(Promise.resolve([1])).resolves.toEqual([1]);
});
