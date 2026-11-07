// Toolbar commands → saved markdown. Each control runs on a real
// Milkdown editor (the presets NoteEditor mounts) and the serialized
// result must be the plain markdown a person would have typed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { history } from "@milkdown/kit/plugin/history";
import { listener } from "@milkdown/kit/plugin/listener";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { TextSelection } from "@milkdown/kit/prose/state";
import { getMarkdown, replaceAll } from "@milkdown/kit/utils";
import { formatState, runFormat, type FormatAction, type FormatState } from "./noteFormat.ts";

let win: Window;
let installed: string[] = [];
const installGlobal = (name: string, value: unknown) => {
	Reflect.set(globalThis, name, value);
	installed.push(name);
};

beforeAll(() => {
	win = new Window();
	// ProseMirror reads DOM APIs off the globals at module scope —
	// window/document plus the view objects it touches directly.
	for (const name of [
		"window",
		"document",
		"navigator",
		"localStorage",
		"Event",
		"CustomEvent",
		"MutationObserver",
		"Range",
		"Node",
		"HTMLElement",
		"HTMLUnknownElement",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	] as const) {
		const value = Reflect.get(win as unknown as Record<string, unknown>, name);
		if (value !== undefined) installGlobal(name, value);
	}
	// @milkdown/ctx signals readiness with a bare dispatchEvent/
	// addEventListener pair — they must land on the same EventTarget
	// realm that produced the CustomEvent (happy-dom's), not Bun's.
	installGlobal("dispatchEvent", win.dispatchEvent.bind(win));
	installGlobal("addEventListener", win.addEventListener.bind(win));
	installGlobal("removeEventListener", win.removeEventListener.bind(win));
});

afterAll(async () => {
	await win.happyDOM.close();
	for (const name of installed) Reflect.deleteProperty(globalThis, name);
	installed = [];
});

async function makeEditor(): Promise<Editor> {
	const container = win.document.createElement("div");
	win.document.body.appendChild(container);
	return Editor.make()
		.config((ctx) => {
			// happy-dom's element type isn't lib.dom's Node — same cast
			// the mounted tests use at the realm seam.
			ctx.set(rootCtx, container as unknown as HTMLElement);
			ctx.set(defaultValueCtx, "");
		})
		.use(commonmark)
		.use(gfm)
		.use(listener)
		.use(history)
		.create();
}

const md = (ed: Editor): string => ed.action(getMarkdown());

// Select `text` (or put the caret at its start when `caret`) in the doc.
function select(ed: Editor, text: string, caret = false): void {
	ed.action((ctx) => {
		const view = ctx.get(editorViewCtx);
		let found = -1;
		view.state.doc.descendants((n, pos) => {
			if (found >= 0 || !n.isText) return;
			const i = (n.text ?? "").indexOf(text);
			if (i >= 0) found = pos + i;
		});
		if (found < 0) throw new Error(`text not found: ${text}`);
		const sel = caret
			? TextSelection.create(view.state.doc, found)
			: TextSelection.create(view.state.doc, found, found + text.length);
		view.dispatch(view.state.tr.setSelection(sel));
	});
}

const fmtOf = (ed: Editor): FormatState => ed.action((ctx) => formatState(ctx.get(editorViewCtx).state));

async function with_(body: string, text: string, a: FormatAction, caret = false): Promise<{ ed: Editor; out: string }> {
	const ed = await makeEditor();
	ed.action(replaceAll(body));
	select(ed, text, caret);
	runFormat(ed, a);
	return { ed, out: md(ed).trimEnd() };
}

describe("toolbar → markdown", () => {
	const marks: [FormatAction["kind"], string][] = [
		["strong", "**word**"],
		["emphasis", "*word*"],
		["strike", "~~word~~"],
		["code", "`word`"],
	];
	for (const [kind, want] of marks) {
		test(`${kind} wraps the selection and toggles back off`, async () => {
			const { ed, out } = await with_("a word here", "word", { kind } as FormatAction);
			expect(out).toBe(`a ${want} here`);
			expect(fmtOf(ed)[kind === "code" ? "code" : kind === "strike" ? "strike" : kind]).toBe(true);
			runFormat(ed, { kind } as FormatAction);
			expect(md(ed).trimEnd()).toBe("a word here");
		});
	}

	test("heading levels and back to paragraph", async () => {
		const { ed, out } = await with_("Title line", "Title", { kind: "block", to: 2 }, true);
		expect(out).toBe("## Title line");
		expect(fmtOf(ed).block).toBe("h2");
		runFormat(ed, { kind: "block", to: 1 });
		expect(md(ed).trimEnd()).toBe("# Title line");
		runFormat(ed, { kind: "block", to: "paragraph" });
		expect(md(ed).trimEnd()).toBe("Title line");
		expect(fmtOf(ed).block).toBe("paragraph");
	});

	test("typing `# ` heading turns back with Paragraph", async () => {
		const { ed } = await with_("# Typed", "Typed", { kind: "block", to: "paragraph" }, true);
		expect(md(ed).trimEnd()).toBe("Typed");
	});

	test("link adds, reports its href, and removes", async () => {
		const { ed, out } = await with_("see docs now", "docs", { kind: "link", href: "https://example.com" });
		expect(out).toBe("see [docs](https://example.com) now");
		expect(fmtOf(ed).link).toBe("https://example.com");
		select(ed, "docs", true);
		runFormat(ed, { kind: "link", href: null });
		expect(md(ed).trimEnd()).toBe("see docs now");
	});

	test("link with no selection inserts the address as the link", async () => {
		const { out } = await with_("x", "x", { kind: "link", href: "https://a.b" }, true);
		expect(out).toBe("<https://a.b>x");
	});

	test("bullet list wraps, then lifts out", async () => {
		const { ed, out } = await with_("item", "item", { kind: "bullet" });
		expect(out).toBe("* item");
		expect(fmtOf(ed).bullet).toBe(true);
		runFormat(ed, { kind: "bullet" });
		expect(md(ed).trimEnd()).toBe("item");
	});

	test("numbered list wraps; bullet switches its type", async () => {
		const { ed, out } = await with_("item", "item", { kind: "ordered" });
		expect(out).toBe("1. item");
		expect(fmtOf(ed).ordered).toBe(true);
		runFormat(ed, { kind: "bullet" });
		expect(md(ed).trimEnd()).toBe("* item");
		runFormat(ed, { kind: "ordered" });
		runFormat(ed, { kind: "ordered" });
		expect(md(ed).trimEnd()).toBe("item");
	});

	test("task list writes [ ] and the toggle drops it", async () => {
		const { ed, out } = await with_("todo", "todo", { kind: "task" });
		expect(out).toBe("* [ ] todo");
		expect(fmtOf(ed).task).toBe(true);
		expect(fmtOf(ed).bullet).toBe(false);
		runFormat(ed, { kind: "task" });
		expect(md(ed).trimEnd()).toBe("* todo");
		expect(fmtOf(ed).bullet).toBe(true);
	});

	test("task on an existing bullet list keeps the list", async () => {
		const { out } = await with_("- one\n- two", "one", { kind: "task" });
		expect(out).toBe("* [ ] one\n* two");
	});

	test("quote wraps and unwraps", async () => {
		const { ed, out } = await with_("said", "said", { kind: "quote" });
		expect(out).toBe("> said");
		expect(fmtOf(ed).quote).toBe(true);
		runFormat(ed, { kind: "quote" });
		expect(md(ed).trimEnd()).toBe("said");
	});

	test("code block wraps and turns back to text", async () => {
		const { ed, out } = await with_("let x", "let x", { kind: "codeblock" });
		expect(out).toBe("```\nlet x\n```");
		expect(fmtOf(ed).block).toBe("code");
		runFormat(ed, { kind: "codeblock" });
		expect(md(ed).trimEnd()).toBe("let x");
	});

	test("horizontal rule inserts ---", async () => {
		const { out } = await with_("above", "above", { kind: "hr" }, true);
		expect(out).toBe("above\n\n***");
	});

	test("undo and redo follow history", async () => {
		const { ed } = await with_("a word", "word", { kind: "strong" });
		expect(fmtOf(ed).canUndo).toBe(true);
		runFormat(ed, { kind: "undo" });
		expect(md(ed).trimEnd()).toBe("a word");
		expect(fmtOf(ed).canRedo).toBe(true);
		runFormat(ed, { kind: "redo" });
		expect(md(ed).trimEnd()).toBe("a **word**");
	});
});
