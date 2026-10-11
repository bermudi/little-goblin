// The note editor's markdown round-trip gate (design/projects.md →
// Notes): Milkdown's parser→serializer must be idempotent and
// content-preserving over the GFM surface notes actually carry, or
// every autosave would silently rewrite the operator's text.
//
// Driven through the real Editor — the same presets NoteEditor mounts
// (commonmark + gfm + listener + history). Runs under happy-dom like
// the rest of the client tests; ProseMirror mounts into a detached
// div, which is all a serialize pass needs.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { Editor, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { history } from "@milkdown/kit/plugin/history";
import { listener } from "@milkdown/kit/plugin/listener";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { getMarkdown, replaceAll } from "@milkdown/kit/utils";

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

// s∘p — parse markdown into the doc, serialize it straight back out.
async function sp(editor: Editor, md: string): Promise<string> {
	editor.action(replaceAll(md));
	return editor.action(getMarkdown());
}

interface Fixture {
	name: string;
	md: string;
	// Literal text the serializer must carry back — normalization of
	// syntax (bullet markers, emphasis style) is allowed; content isn't.
	survives: string[];
}

const fixtures: Fixture[] = [
	{
		name: "headings, emphasis, links, blockquote",
		md: `# Title

Some *emphasis* and **strong** text with a [link](https://a.dev/x).

> quoted
> lines`,
		survives: ["Title", "emphasis", "strong", "[link](https://a.dev/x)", "quoted"],
	},
	{
		name: "nested and task lists",
		md: `- one
  - nested a
  - nested b
- two

- [x] done
- [ ] todo`,
		survives: ["one", "nested a", "nested b", "two", "[x] done", "[ ] todo"],
	},
	{
		name: "table",
		md: `| a | b |
| - | - |
| 1 | 2 |`,
		survives: ["a", "b", "1", "2"],
	},
	{
		name: "code fence",
		md: "```ts\nconst x: number = 1;\n```",
		survives: ["const x: number = 1;"],
	},
	{
		name: "a triple fence inside a quad fence",
		md: "````markdown\nbefore\n\n```ts\ninner();\n```\n\nafter\n````",
		survives: ["before", "```ts", "inner();", "after"],
	},
	{
		name: "inline code and strikethrough",
		md: "Run `bun test` — it is ~~slow~~ fast.",
		survives: ["`bun test`", "~~slow~~", "fast"],
	},
];

describe("note markdown round-trip", () => {
	test("serialization is idempotent over the GFM fixture set", async () => {
		const editor = await makeEditor();
		try {
			for (const f of fixtures) {
				const once = await sp(editor, f.md);
				const twice = await sp(editor, once);
				const thrice = await sp(editor, twice);
				expect(thrice, f.name).toBe(twice);
			}
		} finally {
			await editor.destroy();
		}
	});

	test("fixture content survives the round trip", async () => {
		const editor = await makeEditor();
		try {
			for (const f of fixtures) {
				const out = await sp(editor, f.md);
				for (const text of f.survives) {
					expect(out, `${f.name}: ${text}`).toContain(text);
				}
			}
		} finally {
			await editor.destroy();
		}
	});
});
