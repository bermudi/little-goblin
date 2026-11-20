// Failed assertions on happy-dom nodes stay small and readable (#798).
//
// bun prints a failed matcher's values by walking every own property,
// symbol-keyed ones included. A happy-dom node keeps its state in such
// properties (parent, owner document, caches, listeners) and React adds
// its fiber and props, so one node reaches the whole mounted app. With
// <App /> mounted, the printout grew until the 2 GB cap killed the run:
// exit 137, no test output.
//
// bun has two printers. The one behind "Received:" (toBe, toBeNull,
// toBeTruthy, toContain, …) honours Bun.inspect.custom, so nodes get a
// one-line form below. The diff printer (toEqual & co.) honours no hook
// in bun 1.4.4, so those matchers refuse a node before they print.
//
// Preloaded for every test run by bunfig.toml: the app tests build their
// own happy-dom Window per file, but all windows share these prototypes.

import type { expect } from "bun:test";
import { Element, EventTarget, Node } from "happy-dom";
import { types } from "node:util";

const TEXT_CHARS = 60;
const ATTR_CHARS = 40;
const MAX_ATTRS = 6;
/** Text, CDATA, processing instruction and comment: nodes whose content is their text. */
const TEXT_NODE_TYPES = new Set([3, 4, 7, 8]);

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** One line that names a node the way its markup would: `<li class="row">item 1</li>`. */
export function describeNode(node: Node): string {
	if (node instanceof Element) {
		const names = node.getAttributeNames();
		const attrs = names
			.slice(0, MAX_ATTRS)
			.map((name) => ` ${name}="${clip(node.getAttribute(name) ?? "", ATTR_CHARS)}"`)
			.join("");
		const more = names.length > MAX_ATTRS ? " …" : "";
		const text = clip(node.textContent, TEXT_CHARS);
		return `<${node.localName}${attrs}${more}>${text}</${node.localName}>`;
	}
	if (TEXT_NODE_TYPES.has(node.nodeType)) {
		return `${node.nodeName} "${clip(node.textContent ?? "", TEXT_CHARS)}"`;
	}
	return `${node.nodeName} (${node.childNodes.length} children)`;
}

function describeTarget(target: EventTarget): string {
	return target instanceof Node ? describeNode(target) : `${target.constructor.name} {}`;
}

for (const proto of [EventTarget.prototype, Node.prototype]) {
	Object.defineProperty(proto, Bun.inspect.custom, {
		configurable: true,
		value(this: EventTarget) {
			return describeTarget(this);
		},
	});
}

type Found = { path: string; target: EventTarget };

function keyPath(key: string | symbol): string {
	return typeof key === "symbol" || !/^[A-Za-z_$][\w$]*$/.test(key)
		? `[${String(key)}]`
		: `.${key}`;
}

/** First happy-dom node (or window) the diff printer would reach from `root`. */
function findTarget(root: unknown, rootPath: string): Found | null {
	const seen = new Set<object>();
	const stack: [unknown, string][] = [[root, rootPath]];
	for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
		const [value, path] = next;
		if (value === null || (typeof value !== "object" && typeof value !== "function")) continue;
		if (types.isProxy(value)) continue;
		if (value instanceof EventTarget) return { path, target: value };
		if (seen.has(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) continue;
		seen.add(value);
		if (value instanceof Map) {
			for (const [k, v] of Map.prototype.entries.call(value)) {
				stack.push([k, `${path}.keys()`], [v, `${path}.get(…)`]);
			}
		} else if (value instanceof Set) {
			for (const v of Set.prototype.values.call(value)) stack.push([v, `${path}.values()`]);
		}
		for (const key of Reflect.ownKeys(value)) {
			const desc = Object.getOwnPropertyDescriptor(value, key);
			if (desc !== undefined && "value" in desc) stack.push([desc.value, `${path}${keyPath(key)}`]);
		}
	}
	return null;
}

function mockCalls(received: unknown): unknown {
	return typeof received === "function" && "mock" in received
		? (received.mock as { calls: unknown }).calls
		: received;
}

function propertyAt(received: unknown, path: unknown): unknown {
	const keys = Array.isArray(path) ? path : String(path).split(/[.[\]]+/).filter(Boolean);
	let value = received;
	for (const key of keys) {
		if (value === null || value === undefined) return undefined;
		value = (value as Record<PropertyKey, unknown>)[key as PropertyKey];
	}
	return value;
}

/** What each diff-printing matcher prints, as [label, value] roots. */
type Roots = (received: unknown, args: unknown[]) => [string, unknown][];
const wholeValues: Roots = (received, args) => [
	["received", received],
	["expected", args],
];
const callsAndArgs: Roots = (received, args) => [
	["received.mock.calls", mockCalls(received)],
	["expected", args],
];
const DIFF_MATCHERS: Record<string, Roots> = {
	toEqual: wholeValues,
	toStrictEqual: wholeValues,
	toMatchObject: wholeValues,
	toHaveBeenCalledWith: callsAndArgs,
	toBeCalledWith: callsAndArgs,
	toHaveBeenLastCalledWith: callsAndArgs,
	lastCalledWith: callsAndArgs,
	toHaveBeenNthCalledWith: callsAndArgs,
	nthCalledWith: callsAndArgs,
	// Prints only the value at the path and the expected value.
	toHaveProperty: (received, [path, ...value]) => [
		[`received${keyPath(String(path))}`, propertyAt(received, path)],
		["expected", value],
	],
};

// bun never shows a matcher its received value, so `expect` itself is
// wrapped to record it per Expect object. Test files see the wrapper only
// if nothing imported "bun:test" as a module before the swap (unverified
// cause of the swap failing behind testkit.ts): hence no value import
// here, the slot before testkit.ts in bunfig.toml, and the module-side
// check below, which fails the whole run loudly instead of letting a node
// reach bun's printer.
//
// bun 1.4.4's .resolves / .rejects getters are non-configurable and return
// the same Expect object, so the guard cannot tell the mode. A Promise
// received by a diff matcher goes straight to bun; nodes inside its result
// are not guarded. So does a Proxy received: the guard never runs traps.
const bunTest = require("bun:test") as { expect: typeof expect };
const nativeExpect = bunTest.expect;
const receivedOf = new WeakMap<object, unknown>();
const wrappedExpect = new Proxy(nativeExpect, {
	apply(target, thisArg, args: unknown[]) {
		const expectation = Reflect.apply(target, thisArg, args) as ReturnType<typeof expect>;
		receivedOf.set(expectation, args[0]);
		return expectation;
	},
});
bunTest.expect = wrappedExpect;
const esm = await import("bun:test");
if (esm.expect !== wrappedExpect) {
	throw new Error(
		"happy-dom assertion guard not installed: test files would get bun's own expect (#798). " +
			"Something imported bun:test before app/src/test-dom-print.ts; keep it before testkit.ts in bunfig.toml.",
	);
}

type Matcher = (this: object, ...args: unknown[]) => unknown;
const matchers = Object.getPrototypeOf(nativeExpect(null)) as Record<string, Matcher>;

function refusal(name: string, found: Found): Error {
	return new Error(
		`${name}() got a happy-dom node at ${found.path}: ${describeTarget(found.target)}\n` +
			"bun's diff printer dumps every object a node reaches; with an app mounted that " +
			"exhausts memory (#798). Assert identity with toBe(), or compare a property such " +
			"as textContent.",
	);
}

for (const [name, roots] of Object.entries(DIFF_MATCHERS)) {
	const native = matchers[name];
	if (native === undefined) throw new Error(`bun:test has no ${name} matcher to guard`);
	matchers[name] = function (this: object, ...args: unknown[]): unknown {
		const received = receivedOf.get(this);
		// util.types reads internal slots, so a Proxy's traps never run here.
		if (!receivedOf.has(this) || types.isProxy(received) || types.isPromise(received)) {
			return Reflect.apply(native, this, args);
		}
		for (const [label, root] of roots(received, args)) {
			const found = findTarget(root, label);
			if (found !== null) throw refusal(name, found);
		}
		return Reflect.apply(native, this, args);
	};
}
