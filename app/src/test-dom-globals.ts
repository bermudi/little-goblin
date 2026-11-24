import { HTMLElement, HTMLSlotElement } from "happy-dom";

if (globalThis.HTMLSlotElement === undefined) {
	Reflect.set(globalThis, "HTMLSlotElement", HTMLSlotElement);
}
if (typeof Reflect.get(HTMLElement.prototype, "showPopover") !== "function") {
	Reflect.set(HTMLElement.prototype, "showPopover", () => {});
}
