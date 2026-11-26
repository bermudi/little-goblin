import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { startUpload } from "./uploads.ts";
import { boxView, MessageBox, type MessageBoxHandle } from "./MessageBox.tsx";
import type { Draft } from "./draft.ts";

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
let installed: string[] = [];
let saved: [string, unknown][] = [];
const realFetch = globalThis.fetch;

const installGlobal = (name: string, value: unknown) => {
	const prior = Reflect.get(globalThis, name);
	if (prior === undefined) installed.push(name);
	else saved.push([name, prior]);
	Reflect.set(globalThis, name, value);
};

beforeEach(() => {
	win = new Window();
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
	installed = [];
	saved = [];
	for (const name of [
		"window",
		"document",
		"navigator",
		"localStorage",
		"Event",
		"ErrorEvent",
		"CustomEvent",
		"MutationObserver",
		"ResizeObserver",
		"Range",
		"Node",
		"NodeFilter",
		"HTMLElement",
		"HTMLInputElement",
		"HTMLTextAreaElement",
		"HTMLButtonElement",
		"HTMLAnchorElement",
		"HTMLSlotElement",
		"HTMLUnknownElement",
		"KeyboardEvent",
		"ClipboardEvent",
		"DataTransfer",
		"DOMParser",
		"getComputedStyle",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	] as const) {
		const value = Reflect.get(win as unknown as Record<string, unknown>, name);
		if (value !== undefined) installGlobal(name, value);
	}
	installGlobal("dispatchEvent", win.dispatchEvent.bind(win));
	installGlobal("addEventListener", win.addEventListener.bind(win));
	installGlobal("removeEventListener", win.removeEventListener.bind(win));
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response(new Blob([new Uint8Array([1])], { type: "image/png" }), {
				status: 200,
				headers: { "content-type": "image/png" },
			}),
		)) as unknown as typeof fetch;
});

afterEach(async () => {
	if (root !== null) {
		await act(async () => {
			root?.unmount();
		});
		root = null;
	}
	await win.happyDOM.close();
	globalThis.fetch = realFetch;
	Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
	for (const name of installed) Reflect.deleteProperty(globalThis, name);
	for (const [name, value] of saved) Reflect.set(globalThis, name, value);
	saved = [];
});

const noteChip = { kind: "note", id: "n-1", title: "Budget" } as const;
const imageChip = {
	kind: "file",
	state: "ready",
	ref: { path: "attachments/a.png", mediaType: "image/png", filename: "a.png", size: 3 },
} as const;
const failedChip = {
	kind: "file",
	state: "failed",
	uploadId: "gone",
	filename: "b.png",
	mediaType: "image/png",
	size: 4,
} as const;

const view = (el: Element | null = container.querySelector(".message-box")): EditorView | undefined =>
	el === null ? undefined : boxView(el);
const key = (k: string, opts: Record<string, unknown> = {}) => {
	const KE = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
	view()?.dom.dispatchEvent(
		new KE("keydown", { key: k, bubbles: true, cancelable: true, ...opts }) as unknown as Event,
	);
};
const clipboard = (type: string, plain: string, html?: string) => {
	const CE = (win as unknown as { ClipboardEvent: typeof ClipboardEvent }).ClipboardEvent;
	const DT = (win as unknown as { DataTransfer: typeof DataTransfer }).DataTransfer;
	const dt = new DT();
	dt.setData("text/plain", plain);
	if (html !== undefined) dt.setData("text/html", html);
	view()?.dom.dispatchEvent(new CE(type, { bubbles: true, cancelable: true, clipboardData: dt }) as unknown as Event);
	return { plain: dt.getData("text/plain"), html: dt.getData("text/html") };
};
const paste = (plain: string, html?: string) => {
	clipboard("paste", plain, html);
};

interface MountOpts {
	initial?: Draft;
	onEnter?: (mode: "steer" | "followUp") => void;
	onChange?: (draft: Draft) => void;
	onFiles?: (files: File[]) => void;
}
const mount = async (opts: MountOpts = {}): Promise<MessageBoxHandle> => {
	if (root !== null) {
		await act(async () => {
			root?.unmount();
		});
	}
	const handle = createRef<MessageBoxHandle>();
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<MessageBox
				ref={handle}
				initial={opts.initial ?? null}
				onEnter={opts.onEnter}
				onChange={opts.onChange}
				onFiles={opts.onFiles}
				token="token"
			/>,
		);
	});
	await act(async () => {});
	expect(handle.current).not.toBeNull();
	return handle.current as MessageBoxHandle;
};

const click = (sel: string) => {
	(container.querySelector(sel) as HTMLButtonElement | null)?.click();
};

const edit = async (fn: (v: EditorView) => void) => {
	await act(async () => {
		const v = view();
		if (v !== undefined) fn(v);
	});
};

const docText = (): string => {
	const v = view();
	if (v === undefined) return "";
	let out = "";
	v.state.doc.forEach((para, i) => {
		if (i > 0) out += "\n";
		para.forEach((node) => {
			out += node.isText ? (node.text ?? "") : "☒";
		});
	});
	return out;
};
const chipCount = (): number => {
	const v = view();
	if (v === undefined) return 0;
	let n = 0;
	v.state.doc.descendants((node) => {
		if (node.type.name === "goblinChip") n++;
	});
	return n;
};
const findChip = (v: EditorView): number | null => {
	let found: number | null = null;
	v.state.doc.descendants((node, pos) => {
		if (found !== null) return false;
		if (node.type.name === "goblinChip") {
			found = pos;
			return false;
		}
		return true;
	});
	return found;
};
const selectChip = (v: EditorView): boolean => {
	const pos = findChip(v);
	if (pos === null) return false;
	v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, pos)));
	return true;
};

describe("MessageBox", () => {
	test("insert at a mid-word caret spaces both sides; at the end of an unfocused box, only after", async () => {
		const box = await mount();
		const v = view();
		expect(v).not.toBeUndefined();
		if (v === undefined) return;
		box.focus();
		await edit((v) => v.dispatch(v.state.tr.insertText("hello")));
		await edit((v) => v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 4))));
		await act(async () => {
			box.insertChips([{ ...noteChip }]);
		});
		expect(docText()).toBe("hel ☒ lo");
		const box2 = await mount();
		await edit((v) => v.dispatch(v.state.tr.insertText("hello")));
		await act(async () => {
			box2.insertChips([{ ...noteChip }]);
		});
		expect(docText()).toBe("hello ☒ ");
	});

	test("no doubled spaces when the caret already sits beside whitespace or the box is empty", async () => {
		const box = await mount();
		await edit((v) => v.dispatch(v.state.tr.insertText("hello ")));
		await edit((v) => v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 6))));
		await act(async () => {
			box.insertChips([{ ...noteChip }]);
		});
		expect(docText()).toBe("hello ☒ ");
		const box2 = await mount();
		await act(async () => {
			box2.insertChips([{ ...noteChip }]);
		});
		expect(docText()).toBe("☒ ");
	});

	test("Backspace removes a node-selected chip; undo brings it back", async () => {
		const box = await mount();
		await act(async () => {
			box.insertChips([{ ...noteChip }]);
		});
		expect(chipCount()).toBe(1);
		await new Promise((res) => setTimeout(res, 550));
		await edit((v) => {
			expect(selectChip(v)).toBe(true);
		});
		await act(async () => {
			key("Backspace");
		});
		expect(chipCount()).toBe(0);
		await act(async () => {
			key("z", { ctrlKey: true });
		});
		expect(chipCount()).toBe(1);
	});

	test("cut then paste moves the chip within the box", async () => {
		const box = await mount();
		await act(async () => {
			box.insertChips([{ ...noteChip }]);
		});
		await edit((v) => v.dispatch(v.state.tr.insertText("done")));
		await edit((v) =>
			v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, v.state.doc.content.size - 1))),
		);
		const data = await act(async () => clipboard("cut", ""));
		expect(data?.plain).toContain("[Budget]");
		expect(data?.html).toContain("data-goblin-chip");
		expect(chipCount()).toBe(0);
		expect(docText()).toBe("");
		await act(async () => {
			paste(data.plain, data.html);
		});
		expect(chipCount()).toBe(1);
		expect(docText()).toBe("☒ done");
	});

	test("copy from one box, paste into a second box keeps the reference", async () => {
		if (root !== null) {
			await act(async () => {
				root?.unmount();
			});
		}
		const first = createRef<MessageBoxHandle>();
		const second = createRef<MessageBoxHandle>();
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<>
					<MessageBox ref={first} token="token" />
					<MessageBox ref={second} token="token" />
				</>,
			);
		});
		await act(async () => {});
		const boxes = [...container.querySelectorAll(".message-box")];
		expect(boxes.length).toBe(2);
		const v1 = view(boxes[0] ?? null);
		if (v1 === undefined) return;
		await edit((v) => v.dispatch(v.state.tr.insertText("see ")));
		await act(async () => {
			(first.current as MessageBoxHandle).insertChips([{ ...imageChip }]);
		});
		await edit((v) =>
			v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, v.state.doc.content.size - 1))),
		);
		const data = await act(async () => clipboard("copy", ""));
		expect(data?.plain).toContain("[a.png]");
		expect(data?.html).toContain("data-goblin-chip");
		const v2 = view(boxes[1] ?? null);
		if (v2 === undefined) return;
		await act(async () => {
			const CE = (win as unknown as { ClipboardEvent: typeof ClipboardEvent }).ClipboardEvent;
			const DT = (win as unknown as { DataTransfer: typeof DataTransfer }).DataTransfer;
			const dt = new DT();
			dt.setData("text/plain", data.plain);
			dt.setData("text/html", data.html);
			v2.dom.dispatchEvent(
				new CE("paste", { bubbles: true, cancelable: true, clipboardData: dt }) as unknown as Event,
			);
		});
		expect(chipCount()).toBe(1);
		const draft = (second.current as MessageBoxHandle).getDraft();
		expect(draft.items).toEqual([
			{ type: "text", text: "see " },
			{ type: "chip", chip: { ...imageChip } },
			{ type: "text", text: " " },
		]);
		expect(draft.shelf).toEqual([{ ...imageChip }]);
	});

	test("a hostile data-goblin-chip pastes as text", async () => {
		await mount();
		await edit((v) => v.dispatch(v.state.tr.insertText("x")));
		const cases = [
			'<span data-goblin-chip="{not json">label</span>',
			'<span data-goblin-chip=' +
				JSON.stringify(JSON.stringify({ kind: "note", id: "n", title: "t", extra: 1 })) +
				">label</span>",
			'<span data-goblin-chip=' + JSON.stringify(JSON.stringify({ kind: "robot", id: "r" })) + ">label</span>",
		];
		for (const html of cases) {
			await act(async () => {
				paste("label", html);
			});
			expect(chipCount()).toBe(0);
			expect(docText()).toContain("label");
		}
	});

	test("foreign HTML pastes as plain text; a multi-line paste splits lines", async () => {
		await mount();
		await act(async () => {
			paste("line one", "<div>line <b>one</b> more</div>");
		});
		expect(docText()).toBe("line one");
		const box2 = await mount();
		void box2;
		await act(async () => {
			paste("a\nb");
		});
		expect(docText()).toBe("a\nb");
	});

	test("Enter steers, Alt-Enter queues, Shift-Enter breaks a line, IME never sends", async () => {
		const modes: string[] = [];
		const box = await mount({ onEnter: (mode) => modes.push(mode) });
		await edit((v) => v.dispatch(v.state.tr.insertText("hi")));
		await act(async () => {
			key("Enter");
		});
		expect(modes).toEqual(["steer"]);
		expect(docText()).toBe("hi");
		await act(async () => {
			key("Enter", { altKey: true });
		});
		expect(modes).toEqual(["steer", "followUp"]);
		await act(async () => {
			key("Enter", { shiftKey: true });
		});
		expect(modes).toEqual(["steer", "followUp"]);
		expect(docText()).toBe("hi\n");
		await act(async () => {
			key("Enter", { isComposing: true });
		});
		expect(modes).toEqual(["steer", "followUp"]);
		expect(docText()).toBe("hi\n");
	});

	test("the popover opens on Enter over a selected chip, and Remove deletes the chip", async () => {
		const box = await mount();
		await act(async () => {
			box.insertChips([{ ...noteChip }]);
		});
		await edit((v) => {
			expect(selectChip(v)).toBe(true);
		});
		await act(async () => {
			key("Enter");
		});
		const content = container.querySelector('[role="dialog"]');
		expect(content).not.toBeNull();
		expect(content?.textContent).toContain("Budget");
		expect(content?.textContent).toContain("Open note");
		await act(async () => {
			const remove = [...container.querySelectorAll("button")].find((b) => b.textContent === "Remove");
			remove?.click();
		});
		expect(chipCount()).toBe(0);
		expect(container.querySelector('[role="dialog"]')).toBeNull();
	});

	test("Escape on the open popover closes it without deleting the chip", async () => {
		const box = await mount();
		await act(async () => {
			box.insertChips([{ ...noteChip }]);
		});
		await edit((v) => {
			expect(selectChip(v)).toBe(true);
		});
		await act(async () => {
			key("Enter");
		});
		const content = container.querySelector('[role="dialog"]');
		expect(content).not.toBeNull();
		await act(async () => {
			const KE = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
			content?.dispatchEvent(
				new KE("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
		await act(async () => {});
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(chipCount()).toBe(1);
	});

	test("beforeinput deleteContentBackward with the caret after a chip deletes the chip, and undo restores it", async () => {
		const draft: Draft = {
			items: [
				{ type: "text", text: "hi " },
				{ type: "chip", chip: { ...noteChip } },
				{ type: "text", text: " bye" },
			],
			shelf: [],
		};
		await mount({ initial: draft });
		await new Promise((r) => setTimeout(r, 550));
		await edit((v) => {
			v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 5)));
		});
		const IE = (win as unknown as { InputEvent: typeof InputEvent }).InputEvent;
		await act(async () => {
			view()?.dom.dispatchEvent(
				new IE("beforeinput", {
					inputType: "deleteContentBackward",
					bubbles: true,
					cancelable: true,
				}) as unknown as Event,
			);
		});
		expect(chipCount()).toBe(0);
		expect(docText()).toBe("hi  bye");
		await act(async () => {
			key("z", { ctrlKey: true });
		});
		expect(chipCount()).toBe(1);
	});

	test("beforeinput deleteContentForward with the caret before a chip deletes the chip", async () => {
		const draft: Draft = {
			items: [
				{ type: "text", text: "hi " },
				{ type: "chip", chip: { ...noteChip } },
				{ type: "text", text: " bye" },
			],
			shelf: [],
		};
		await mount({ initial: draft });
		await edit((v) => {
			v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 4)));
		});
		const IE = (win as unknown as { InputEvent: typeof InputEvent }).InputEvent;
		await act(async () => {
			view()?.dom.dispatchEvent(
				new IE("beforeinput", {
					inputType: "deleteContentForward",
					bubbles: true,
					cancelable: true,
				}) as unknown as Event,
			);
		});
		expect(chipCount()).toBe(0);
		expect(docText()).toBe("hi  bye");
	});

	test("beforeinput delete with the DOM selection inside the chip's name deletes the chip", async () => {
		const draft: Draft = {
			items: [
				{ type: "text", text: "look " },
				{ type: "chip", chip: { ...noteChip } },
				{ type: "text", text: " here" },
			],
			shelf: [],
		};
		await mount({ initial: draft });
		await edit((v) => {
			v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 12)));
		});
		const nameEl = container.querySelector(".goblin-chip-name") as HTMLElement | null;
		const textNode = nameEl?.firstChild ?? null;
		expect(textNode).not.toBeNull();
		const range = win.document.createRange();
		const node = textNode as unknown as Parameters<typeof range.setStart>[0];
		range.setStart(node, 0);
		range.setEnd(node, 1);
		const sel = win.document.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
		const IE = (win as unknown as { InputEvent: typeof InputEvent }).InputEvent;
		await act(async () => {
			view()?.dom.dispatchEvent(
				new IE("beforeinput", {
					inputType: "deleteContentBackward",
					bubbles: true,
					cancelable: true,
				}) as unknown as Event,
			);
		});
		expect(chipCount()).toBe(0);
	});

	test("a plain click event on a chip opens the popover", async () => {
		const box = await mount();
		await act(async () => {
			box.insertChips([{ ...noteChip }]);
		});
		const ME = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
		await act(async () => {
			container.querySelector(".goblin-chip")?.dispatchEvent(
				new ME("click", { bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
		const content = container.querySelector('[role="dialog"]');
		expect(content).not.toBeNull();
		expect(content?.textContent).toContain("Budget");
	});

	test("a failed chip with a known upload shows the error, and rendering starts no upload", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			throw new Error("net down");
		}) as unknown as typeof fetch;
		const file = new File([new Uint8Array([1])], "b.png", { type: "image/png" });
		const chip = startUpload("token", file);
		expect(chip.state).toBe("uploading");
		await new Promise((r) => setTimeout(r, 10));
		expect(calls).toBe(1);
		const box = await mount();
		await act(async () => {
			box.insertChips([chip]);
		});
		await act(async () => {});
		await edit((v) => {
			expect(selectChip(v)).toBe(true);
		});
		await act(async () => {
			key("Enter");
		});
		await act(async () => {});
		const content = container.querySelector('[role="dialog"]');
		expect(content?.textContent).toContain("Upload failed:");
		expect(content?.textContent).toContain("net down");
		expect(calls).toBe(1);
	});

	test("Open renders as a prefetched anchor for a ready image chip", async () => {
		const draft: Draft = {
			items: [{ type: "text", text: "see " }, { type: "chip", chip: { ...imageChip } }],
			shelf: [{ ...imageChip }],
		};
		await mount({ initial: draft });
		await edit((v) => {
			const pos = findChip(v);
			expect(pos).not.toBeNull();
			v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, pos as number)));
		});
		await act(async () => {
			key("Enter");
		});
		await act(async () => {});
		const link = container.querySelector('[role="dialog"] a');
		expect(link).not.toBeNull();
		expect(link?.getAttribute("href")).toMatch(/^blob:/);
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toBe("noreferrer");
		expect(link?.textContent).toBe("Open");
	});

	test("a failed chip with no known upload says so, with no Retry", async () => {
		const box = await mount();
		await act(async () => {
			box.insertChips([{ ...failedChip }]);
		});
		const chipEl = container.querySelector(".goblin-chip");
		expect(chipEl?.getAttribute("aria-label")).toBe("File b.png, upload failed");
		await edit((v) => {
			expect(selectChip(v)).toBe(true);
		});
		await act(async () => {
			key("Enter");
		});
		const content = container.querySelector('[role="dialog"]');
		expect(content?.textContent).toContain("Upload did not finish. Attach it again.");
		expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(false);
	});

	test("the shelf: deleting the chip keeps the thumbnail, and × then removes the orphaned image", async () => {
		const draft: Draft = {
			items: [{ type: "text", text: "see " }, { type: "chip", chip: { ...imageChip } }],
			shelf: [{ ...imageChip }],
		};
		const box = await mount({ initial: draft });
		expect(container.querySelectorAll(".box-shelf-thumb").length).toBe(1);
		await edit((v) => {
			expect(selectChip(v)).toBe(true);
		});
		await act(async () => {
			key("Backspace");
		});
		expect(chipCount()).toBe(0);
		expect(container.querySelectorAll(".box-shelf-thumb").length).toBe(1);
		await act(async () => {
			click(".box-shelf-thumb button");
		});
		await act(async () => {});
		expect(container.querySelector(".confirm-veil")).toBeNull();
		expect(container.querySelectorAll(".box-shelf-thumb").length).toBe(0);
		void box;
	});

	test("× on a mentioned image asks first; confirming removes the thumbnail and the chip", async () => {
		const seen: Draft[] = [];
		const draft: Draft = {
			items: [{ type: "text", text: "see " }, { type: "chip", chip: { ...imageChip } }],
			shelf: [{ ...imageChip }],
		};
		await mount({ initial: draft, onChange: (d) => seen.push(d) });
		expect(chipCount()).toBe(1);
		await act(async () => {
			click(".box-shelf-thumb button");
		});
		await act(async () => {});
		expect(container.querySelector(".confirm-veil")).not.toBeNull();
		expect(container.querySelector(".confirm-msg")?.textContent).toContain("a.png");
		await act(async () => {
			click(".confirm-cancel");
		});
		await act(async () => {});
		expect(container.querySelectorAll(".box-shelf-thumb").length).toBe(1);
		expect(chipCount()).toBe(1);
		await act(async () => {
			click(".box-shelf-thumb button");
		});
		await act(async () => {});
		await act(async () => {
			click(".confirm-ok");
		});
		await act(async () => {});
		expect(container.querySelectorAll(".box-shelf-thumb").length).toBe(0);
		expect(chipCount()).toBe(0);
		const last = seen[seen.length - 1];
		expect(last?.shelf).toEqual([]);
		expect(last?.items.some((i) => i.type === "chip")).toBe(false);
	});

	test("the shelf thumbnail × on a never-mentioned image removes it without asking", async () => {
		const draft: Draft = {
			items: [{ type: "text", text: "no mention" }],
			shelf: [{ ...imageChip }],
		};
		await mount({ initial: draft });
		expect(container.querySelectorAll(".box-shelf-thumb").length).toBe(1);
		await act(async () => {
			click(".box-shelf-thumb button");
		});
		await act(async () => {});
		expect(container.querySelector(".confirm-veil")).toBeNull();
		expect(container.querySelectorAll(".box-shelf-thumb").length).toBe(0);
	});

	test("pasted files go to onFiles", async () => {
		const files: File[][] = [];
		await mount({ onFiles: (fs) => files.push(fs) });
		const CE = (win as unknown as { ClipboardEvent: typeof ClipboardEvent }).ClipboardEvent;
		const DT = (win as unknown as { DataTransfer: typeof DataTransfer }).DataTransfer;
		const HF = (win as unknown as { File: typeof File }).File;
		const dt = new DT();
		dt.items.add(new HF([new Uint8Array([1])], "p.png", { type: "image/png" }));
		await act(async () => {
			view()?.dom.dispatchEvent(
				new CE("paste", { bubbles: true, cancelable: true, clipboardData: dt }) as unknown as Event,
			);
		});
		expect(files.length).toBe(1);
		expect(files[0]?.[0]?.name).toBe("p.png");
		expect(docText()).toBe("");
	});

	test("setDraft replaces content and shelf; getDraft round-trips; prepend and appendText compose", async () => {
		const box = await mount();
		await act(async () => {
			box.setDraft({
				items: [{ type: "text", text: "one " }, { type: "chip", chip: { ...noteChip } }],
				shelf: [],
			});
		});
		expect(docText()).toBe("one ☒");
		expect(box.getDraft().shelf).toEqual([]);
		await act(async () => {
			box.appendText("quote");
		});
		expect(docText()).toBe("one ☒\nquote");
		await act(async () => {
			box.prepend({ items: [{ type: "text", text: "ahead" }], shelf: [] });
		});
		expect(docText()).toBe("ahead\n\none ☒\nquote");
		const draft = box.getDraft();
		expect(draft.items).toEqual([
			{ type: "text", text: "ahead\n\none " },
			{ type: "chip", chip: { ...noteChip } },
			{ type: "text", text: "\nquote" },
		]);
	});

	test("onChange fires with the normalized draft on every edit", async () => {
		const seen: Draft[] = [];
		const box = await mount({ onChange: (draft) => seen.push(draft) });
		await edit((v) => v.dispatch(v.state.tr.insertText("hi")));
		await act(async () => {
			box.insertChips([{ ...imageChip }]);
		});
		const last = seen[seen.length - 1];
		expect(last?.items).toEqual([
			{ type: "text", text: "hi " },
			{ type: "chip", chip: { ...imageChip } },
			{ type: "text", text: " " },
		]);
		expect(last?.shelf).toEqual([{ ...imageChip }]);
	});
});
