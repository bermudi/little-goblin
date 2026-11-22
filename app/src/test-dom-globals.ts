// @ui-sdk/core's focus walk tests `el instanceof HTMLSlotElement`
// (foundation/focus/tabbable.js). Browsers and each happy-dom Window
// have the class, but bare bun:test has no such global and the app
// tests install window globals per file — so any popup's initial
// focus crashed with ReferenceError once ui-sdk beta.13 started
// reading it. One shared install covers every test file; the class
// is the same object across happy-dom windows, so instanceof stays
// truthful for real slot elements.
import { HTMLSlotElement } from "happy-dom";

if (globalThis.HTMLSlotElement === undefined) {
	Reflect.set(globalThis, "HTMLSlotElement", HTMLSlotElement);
}
