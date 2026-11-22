import { HTMLSlotElement } from "happy-dom";

if (globalThis.HTMLSlotElement === undefined) {
	Reflect.set(globalThis, "HTMLSlotElement", HTMLSlotElement);
}
