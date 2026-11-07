// Formatting state and commands for the note editor's toolbar. Reads
// the ProseMirror state (so the active-state highlight follows the
// selection) and runs Milkdown's own commands; lists and links, which
// Milkdown has no toggle for, use ProseMirror's list/mark commands.
// Output stays plain markdown: nothing here adds a node the commonmark
// + gfm serializer cannot write.

import { commandsCtx, editorViewCtx, type Editor } from "@milkdown/kit/core";
import { lift, toggleMark, wrapIn } from "@milkdown/kit/prose/commands";
import type { MarkType, NodeType } from "@milkdown/kit/prose/model";
import { liftListItem } from "@milkdown/kit/prose/schema-list";
import { TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { redoDepth, undoDepth } from "@milkdown/kit/prose/history";
import {
	createCodeBlockCommand,
	toggleEmphasisCommand,
	toggleInlineCodeCommand,
	toggleStrongCommand,
	turnIntoTextCommand,
	wrapInHeadingCommand,
} from "@milkdown/kit/preset/commonmark";
import { toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { redoCommand, undoCommand } from "@milkdown/kit/plugin/history";

export type BlockKind = "paragraph" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "code" | "other";

export interface FormatState {
	block: BlockKind;
	strong: boolean;
	emphasis: boolean;
	strike: boolean;
	code: boolean;
	// The href of the link under the selection, else null.
	link: string | null;
	bullet: boolean;
	ordered: boolean;
	task: boolean;
	quote: boolean;
	canUndo: boolean;
	canRedo: boolean;
}

export type FormatAction =
	| { kind: "block"; to: "paragraph" | 1 | 2 | 3 }
	| { kind: "strong" | "emphasis" | "strike" | "code" }
	| { kind: "link"; href: string | null }
	| { kind: "bullet" | "ordered" | "task" | "quote" | "codeblock" | "hr" | "undo" | "redo" };

function markOf(state: EditorState, name: string): MarkType | undefined {
	return state.schema.marks[name];
}

function nodeOf(state: EditorState, name: string): NodeType | undefined {
	return state.schema.nodes[name];
}

function markActive(state: EditorState, name: string): boolean {
	const type = markOf(state, name);
	if (type === undefined) return false;
	const { from, $from, to, empty } = state.selection;
	if (empty) return type.isInSet(state.storedMarks ?? $from.marks()) !== undefined;
	return state.doc.rangeHasMark(from, to, type);
}

function linkHref(state: EditorState): string | null {
	const type = markOf(state, "link");
	if (type === undefined) return null;
	const { $from, from, to, empty } = state.selection;
	if (empty) {
		const m = type.isInSet(state.storedMarks ?? $from.marks());
		return m === undefined ? null : String(m.attrs.href);
	}
	let href: string | null = null;
	state.doc.nodesBetween(from, to, (n) => {
		const m = type.isInSet(n.marks);
		if (m !== undefined && href === null) href = String(m.attrs.href);
	});
	return href;
}

// The nearest ancestor of the selection start with this type name.
function ancestor(state: EditorState, names: string[]) {
	const { $from } = state.selection;
	for (let d = $from.depth; d > 0; d--) {
		const node = $from.node(d);
		if (names.includes(node.type.name)) return { node, depth: d, pos: $from.before(d) };
	}
	return null;
}

export function formatState(state: EditorState): FormatState {
	const { $from } = state.selection;
	const parent = $from.parent;
	let block: BlockKind = "other";
	if (parent.type.name === "paragraph") block = "paragraph";
	else if (parent.type.name === "code_block") block = "code";
	else if (parent.type.name === "heading") {
		const level = Number(parent.attrs.level);
		block = level >= 1 && level <= 6 ? (`h${level}` as BlockKind) : "other";
	}
	const list = ancestor(state, ["bullet_list", "ordered_list"]);
	const item = ancestor(state, ["list_item"]);
	const isTask = item !== null && item.node.attrs.checked != null;
	return {
		block,
		strong: markActive(state, "strong"),
		emphasis: markActive(state, "emphasis"),
		strike: markActive(state, "strike_through"),
		code: markActive(state, "inlineCode"),
		link: linkHref(state),
		bullet: list?.node.type.name === "bullet_list" && !isTask,
		ordered: list?.node.type.name === "ordered_list",
		task: isTask,
		quote: ancestor(state, ["blockquote"]) !== null,
		canUndo: Number(undoDepth(state)) > 0,
		canRedo: Number(redoDepth(state)) > 0,
	};
}

// Operations take the live view: a multi-step edit (wrap, then check)
// dispatches each step and reads view.state again.
type View = import("@milkdown/kit/prose/view").EditorView;

// Set `checked` on every list item the selection touches.
function setChecked(view: View, value: boolean | null): boolean {
	const item = nodeOf(view.state, "list_item");
	if (item === undefined) return false;
	const tr = view.state.tr;
	let changed = false;
	const { from, to } = view.state.selection;
	view.state.doc.nodesBetween(from, to, (n, pos) => {
		if (n.type === item && n.attrs.checked !== value) {
			tr.setNodeMarkup(pos, undefined, { ...n.attrs, checked: value });
			changed = true;
		}
	});
	if (changed) view.dispatch(tr);
	return changed;
}

// Leave the list entirely: lift the selected items out level by level.
function liftOut(view: View): boolean {
	const item = nodeOf(view.state, "list_item");
	if (item === undefined) return false;
	let did = false;
	for (let i = 0; i < 12 && ancestor(view.state, ["bullet_list", "ordered_list"]) !== null; i++) {
		if (!liftListItem(item)(view.state, (tr) => view.dispatch(tr))) break;
		did = true;
	}
	return did;
}

function retype(view: View, to: NodeType): boolean {
	const list = ancestor(view.state, ["bullet_list", "ordered_list"]);
	if (list === null) return false;
	// Each item carries the marker it serializes with (listType + label).
	const tr = view.state.tr.setNodeMarkup(list.pos, to, list.node.attrs);
	const ordered = to.name === "ordered_list";
	const start = Number(list.node.attrs.order ?? 1);
	list.node.forEach((child, offset, i) => {
		tr.setNodeMarkup(list.pos + 1 + offset, undefined, {
			...child.attrs,
			listType: ordered ? "ordered" : "bullet",
			label: ordered ? `${start + i}.` : "•",
		});
	});
	view.dispatch(tr);
	return true;
}

function toggleList(kind: "bullet" | "ordered", view: View): boolean {
	const want = nodeOf(view.state, kind === "bullet" ? "bullet_list" : "ordered_list");
	if (want === undefined) return false;
	const list = ancestor(view.state, ["bullet_list", "ordered_list"]);
	if (list === null) return wrapIn(want)(view.state, (tr) => view.dispatch(tr));
	if (list.node.type !== want) return retype(view, want);
	// A task item is still a bullet list: the bullet button drops the
	// checkbox first, a second press leaves the list.
	if (kind === "bullet" && formatState(view.state).task) return setChecked(view, null);
	return liftOut(view);
}

function toggleTask(view: View): boolean {
	if (formatState(view.state).task) return setChecked(view, null);
	const bullet = nodeOf(view.state, "bullet_list");
	if (bullet === undefined) return false;
	const list = ancestor(view.state, ["bullet_list", "ordered_list"]);
	if (list === null) {
		if (!wrapIn(bullet)(view.state, (tr) => view.dispatch(tr))) return false;
	} else if (list.node.type !== bullet) {
		retype(view, bullet);
	}
	return setChecked(view, false);
}

function toggleQuote(view: View): boolean {
	const q = nodeOf(view.state, "blockquote");
	if (q === undefined) return false;
	const go = (tr: Transaction) => view.dispatch(tr);
	return ancestor(view.state, ["blockquote"]) !== null
		? lift(view.state, go)
		: wrapIn(q)(view.state, go);
}

// Milkdown's own insertHr leaves a stray empty paragraph that saves as
// `<br />`. A rule goes after the current top-level block (or replaces
// an empty one); the caret lands in the block after it, adding one only
// when the rule would otherwise end the note.
function insertRule(view: View): boolean {
	const { state } = view;
	const hr = nodeOf(state, "hr");
	const para = nodeOf(state, "paragraph");
	if (hr === undefined || para === undefined) return false;
	const { $from } = state.selection;
	if ($from.depth < 1) return false;
	const block = $from.node(1);
	const emptyPara = block.type === para && block.content.size === 0;
	const from = emptyPara ? $from.before(1) : $from.after(1);
	const to = emptyPara ? $from.after(1) : from;
	const rule = hr.create();
	const tr = state.tr.replaceWith(from, to, rule);
	const after = from + rule.nodeSize;
	if (after >= tr.doc.content.size) tr.insert(after, para.create());
	tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(after + 1, tr.doc.content.size)), 1));
	view.dispatch(tr.scrollIntoView());
	return true;
}

export function runFormat(ed: Editor, a: FormatAction): void {
	ed.action((ctx) => {
		const view = ctx.get(editorViewCtx);
		const commands = ctx.get(commandsCtx);
		switch (a.kind) {
			case "block":
				if (a.to === "paragraph") commands.call(turnIntoTextCommand.key);
				else commands.call(wrapInHeadingCommand.key, a.to);
				break;
			case "strong":
				commands.call(toggleStrongCommand.key);
				break;
			case "emphasis":
				commands.call(toggleEmphasisCommand.key);
				break;
			case "strike":
				commands.call(toggleStrikethroughCommand.key);
				break;
			case "code":
				commands.call(toggleInlineCodeCommand.key);
				break;
			case "link": {
				const type = markOf(view.state, "link");
				if (type === undefined) break;
				const { from, to, empty } = view.state.selection;
				if (a.href === null) {
					// Remove: the whole link under the cursor, not just a caret.
					const $f = view.state.selection.$from;
					let s = from;
					let e = to;
					if (empty) {
						const r = linkRange($f.parent, $f.parentOffset, type);
						if (r !== null) {
							s = $f.start() + r.from;
							e = $f.start() + r.to;
						}
					}
					view.dispatch(view.state.tr.removeMark(s, e, type));
				} else if (empty) {
					const tr = view.state.tr.insertText(a.href, from);
					view.dispatch(tr.addMark(from, from + a.href.length, type.create({ href: a.href })));
				} else {
					view.dispatch(
						view.state.tr.removeMark(from, to, type).addMark(from, to, type.create({ href: a.href })),
					);
				}
				break;
			}
			case "bullet":
				toggleList("bullet", view);
				break;
			case "ordered":
				toggleList("ordered", view);
				break;
			case "task":
				toggleTask(view);
				break;
			case "quote":
				toggleQuote(view);
				break;
			case "codeblock":
				if (formatState(view.state).block === "code") commands.call(turnIntoTextCommand.key);
				else commands.call(createCodeBlockCommand.key);
				break;
			case "hr":
				insertRule(view);
				break;
			case "undo":
				commands.call(undoCommand.key);
				break;
			case "redo":
				commands.call(redoCommand.key);
				break;
		}
		view.focus();
	});
}

// The extent of the link mark around `offset` inside one text block.
function linkRange(
	parent: import("@milkdown/kit/prose/model").Node,
	offset: number,
	type: MarkType,
): { from: number; to: number } | null {
	let result: { from: number; to: number } | null = null;
	let pos = 0;
	parent.forEach((child, _o, i) => {
		const end = pos + child.nodeSize;
		if (type.isInSet(child.marks) !== undefined && offset >= pos && offset <= end) {
			let from = pos;
			let to = end;
			for (let j = i - 1; j >= 0; j--) {
				const c = parent.child(j);
				if (type.isInSet(c.marks) === undefined) break;
				from -= c.nodeSize;
			}
			for (let j = i + 1; j < parent.childCount; j++) {
				const c = parent.child(j);
				if (type.isInSet(c.marks) === undefined) break;
				to += c.nodeSize;
			}
			result ??= { from, to };
		}
		pos = end;
	});
	return result;
}
