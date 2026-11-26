import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { Popover, PopoverContent } from "@ui-sdk/react/popover";
import { Fragment, Node as PMNode, Schema, Slice, type DOMOutputSpec } from "@milkdown/kit/prose/model";
import { EditorState, NodeSelection, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { keymap } from "@milkdown/kit/prose/keymap";
import { baseKeymap, splitBlock } from "@milkdown/kit/prose/commands";
import { history, redo, undo } from "@milkdown/kit/prose/history";
import { inlineChipLabel } from "../../../src/inline-parts.ts";
import { useConfirm } from "../confirm.tsx";
import { bytes } from "../opsShared.tsx";
import { fetchAttachmentUrl } from "./attachmentUrl.ts";
import { resolveChip, resolveDraft, subscribe, thumbFor, uploadFailure } from "./uploads.ts";
import { chipKey, normalizeDraft, parseChip, sameDraft, type Chip, type Draft, type DraftItem, type FileChip } from "./draft.ts";

export interface MessageBoxHandle {
	getDraft(): Draft;
	setDraft(draft: Draft): void;
	insertChips(chips: Chip[]): void;
	prepend(draft: Draft): void;
	appendText(text: string): void;
	focus(caret?: "end"): void;
}

export interface MessageBoxProps {
	initial?: Draft | null | undefined;
	onChange?: ((draft: Draft) => void) | undefined;
	onEnter?: ((mode: "steer" | "followUp") => void) | undefined;
	onFiles?: ((files: File[]) => void) | undefined;
	onOpenNote?: ((id: string) => void) | undefined;
	onUploadFailed?: ((message: string) => void) | undefined;
	token: string | null;
	ariaLabel?: string | undefined;
	placeholder?: string | undefined;
}

interface PopState {
	chip: Chip;
	anchor: HTMLElement;
	key: string;
}

function chipName(chip: Chip): string {
	if (chip.kind === "note") return chip.title === "" ? "note" : chip.title;
	if (chip.kind === "skill") {
		if ("name" in chip.ref) return chip.ref.name === "" ? "skill" : chip.ref.name;
		const segs = chip.ref.path.split("/").filter(Boolean);
		return (segs[segs.length - 2] as string | undefined) ?? "skill";
	}
	if (chip.state === "ready") return chip.ref.filename === "" ? "file" : chip.ref.filename;
	return chip.filename === "" ? "file" : chip.filename;
}

function chipAria(chip: Chip): string {
	const base =
		chip.kind === "note"
			? `Note ${chip.title}`
			: chip.kind === "skill"
				? `Skill ${chipName(chip)}`
				: `File ${chipName(chip)}`;
	if (chip.kind === "file" && chip.state === "uploading") return `${base}, uploading`;
	return base;
}

function skillHost(chip: Chip): string {
	if (chip.kind !== "skill" || "name" in chip.ref) return "";
	try {
		return new URL(chip.ref.url).host;
	} catch {
		return chip.ref.url;
	}
}

const boxSchema = new Schema({
	nodes: {
		doc: { content: "paragraph+" },
		paragraph: {
			content: "inline*",
			group: "block",
			parseDOM: [{ tag: "p" }],
			toDOM: () => ["p", 0],
		},
		text: { group: "inline" },
		goblinChip: {
			group: "inline",
			inline: true,
			atom: true,
			attrs: { chip: { default: null } },
			toDOM: (node: PMNode): DOMOutputSpec => {
				const chip = node.attrs.chip as Chip | null;
				if (chip === null) return ["span", { class: "goblin-chip" }, "?"];
				const state = chip.kind === "file" && chip.state !== "ready" ? ` ${chip.state}` : "";
				return [
					"span",
					{
						class: `goblin-chip${state}`,
						"data-goblin-chip": JSON.stringify(chip),
						"aria-label": chipAria(chip),
						contenteditable: "false",
					},
					["span", { class: "goblin-chip-icon", "aria-hidden": "true" }, chip.kind === "skill" ? "⚡" : "•"],
					["span", { class: "goblin-chip-name" }, chipName(chip)],
				];
			},
			parseDOM: [
				{
					tag: "span[data-goblin-chip]",
					getAttrs: (dom: string | HTMLElement) => {
						if (typeof dom === "string") return false;
						let value: unknown = null;
						try {
							value = JSON.parse(dom.getAttribute("data-goblin-chip") ?? "");
						} catch {
							return false;
						}
						const chip = parseChip(value);
						return chip === null ? false : { chip };
					},
				},
			],
			leafText: (node: PMNode): string => {
				const chip = node.attrs.chip as Chip;
				return `[${inlineChipLabel(chip.kind, chipName(chip))}]`;
			},
		},
	},
});

const viewBoxes = new WeakMap<Element, EditorView>();

export function boxView(el: Element | null | undefined): EditorView | undefined {
	if (el === null || el === undefined) return undefined;
	const own = viewBoxes.get(el);
	if (own !== undefined) return own;
	const inner = el.querySelector(".message-box");
	return inner === null ? undefined : (viewBoxes.get(inner) ?? undefined);
}

function itemsFromDoc(doc: PMNode): DraftItem[] {
	const items: DraftItem[] = [];
	let current = "";
	const flush = () => {
		if (current !== "") {
			items.push({ type: "text", text: current });
			current = "";
		}
	};
	doc.forEach((para, offset) => {
		if (offset > 0) current += "\n";
		para.forEach((node) => {
			if (node.isText) {
				current += node.text ?? "";
				return;
			}
			if (node.type === boxSchema.nodes.goblinChip) {
				flush();
				items.push({ type: "chip", chip: node.attrs.chip as Chip });
			}
		});
	});
	flush();
	return items;
}

function docFromDraft(draft: Draft): PMNode {
	const lines: (PMNode | null)[][] = [[]];
	for (const item of normalizeDraft(draft).items) {
		if (item.type === "chip") {
			(lines[lines.length - 1] as (PMNode | null)[]).push(
				boxSchema.nodes.goblinChip.create({ chip: item.chip }),
			);
			continue;
		}
		const parts = item.text.split("\n");
		for (let i = 0; i < parts.length; i++) {
			if (i > 0) lines.push([]);
			const seg = parts[i] as string;
			if (seg !== "") (lines[lines.length - 1] as (PMNode | null)[]).push(boxSchema.text(seg));
		}
	}
	return boxSchema.nodes.doc.create(
		null,
		lines.map((line) =>
			boxSchema.nodes.paragraph.create(
				null,
				line.filter((n): n is PMNode => n !== null),
			),
		),
	);
}

type Token = { t: "text"; text: string } | { t: "chip"; chip: Chip } | { t: "break" };

function parseChippedHtml(html: string): Token[] {
	const tokens: Token[] = [];
	const pushText = (text: string) => {
		if (text === "") return;
		const last = tokens[tokens.length - 1];
		if (last !== undefined && last.t === "text") {
			tokens[tokens.length - 1] = { t: "text", text: last.text + text };
			return;
		}
		tokens.push({ t: "text", text });
	};
	const pushBreak = () => {
		const last = tokens[tokens.length - 1];
		if (last === undefined || last.t === "break") return;
		tokens.push({ t: "break" });
	};
	const parsed = new DOMParser().parseFromString(html, "text/html");
	const walk = (node: Node) => {
		if (node.nodeType === 3) {
			pushText(node.nodeValue ?? "");
			return;
		}
		if (node.nodeType !== 1) return;
		const el = node as HTMLElement;
		const tag = el.tagName.toLowerCase();
		if (tag === "span" && el.hasAttribute("data-goblin-chip")) {
			let value: unknown = null;
			try {
				value = JSON.parse(el.getAttribute("data-goblin-chip") ?? "");
			} catch {
				value = null;
			}
			const chip = parseChip(value);
			if (chip !== null) tokens.push({ t: "chip", chip });
			else pushText(el.textContent ?? "");
			return;
		}
		if (tag === "br") {
			pushBreak();
			return;
		}
		const block = tag === "p" || tag === "div" || tag === "li" || tag === "pre" || tag === "blockquote" || /^h[1-6]$/.test(tag);
		if (block) pushBreak();
		for (const child of Array.from(el.childNodes)) walk(child);
		if (block) pushBreak();
	};
	walk(parsed.body);
	while (tokens[tokens.length - 1]?.t === "break") tokens.pop();
	return tokens;
}

function sliceFromTokens(tokens: Token[]): Slice {
	const lines: Token[][] = [[]];
	for (const token of tokens) {
		if (token.t === "break") {
			lines.push([]);
			continue;
		}
		(lines[lines.length - 1] as Token[]).push(token);
	}
	while (lines.length > 1 && (lines[lines.length - 1] as Token[]).length === 0) lines.pop();
	const paragraphs = lines.map((line) => {
		const nodes: PMNode[] = [];
		for (const token of line) {
			if (token.t === "chip") nodes.push(boxSchema.nodes.goblinChip.create({ chip: token.chip }));
			else if (token.t === "text" && token.text !== "") nodes.push(boxSchema.text(token.text));
		}
		return boxSchema.nodes.paragraph.create(null, nodes);
	});
	return new Slice(Fragment.fromArray(paragraphs), 1, 1);
}

function sliceFromPlainText(text: string): Slice {
	const tokens: Token[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) tokens.push({ t: "break" });
		if (lines[i] !== "") tokens.push({ t: "text", text: lines[i] as string });
	}
	return sliceFromTokens(tokens);
}

function sliceFromChippedHtml(html: string, text: string): Slice {
	const tokens = parseChippedHtml(html);
	if (!tokens.some((t) => t.t === "chip")) return sliceFromPlainText(text);
	return sliceFromTokens(tokens);
}

export const MessageBox = forwardRef<MessageBoxHandle, MessageBoxProps>(function MessageBox(
	{ initial, onChange, onEnter, onFiles, onOpenNote, onUploadFailed, token, ariaLabel, placeholder },
	ref,
) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const hadFocusRef = useRef(false);
	const shelfRef = useRef<FileChip[]>(normalizeDraft(initial ?? { items: [], shelf: [] }).shelf);
	const [shelf, setShelf] = useState<FileChip[]>(shelfRef.current);
	const remoteThumbUrls = useRef(new Map<string, string>());
	const rememberRemoteThumb = useCallback((path: string, url: string | null) => {
		if (url === null) remoteThumbUrls.current.delete(path);
		else remoteThumbUrls.current.set(path, url);
	}, []);
	const [pop, setPop] = useState<PopState | null>(null);
	const [showPlaceholder, setShowPlaceholder] = useState(
		normalizeDraft(initial ?? { items: [], shelf: [] }).items.every(
			(i) => i.type === "text" && i.text.trim() === "",
		),
	);
	const confirm = useConfirm();
	const onChangeRef = useRef(onChange);
	const onEnterRef = useRef(onEnter);
	const onFilesRef = useRef(onFiles);
	const onOpenNoteRef = useRef(onOpenNote);
	const onUploadFailedRef = useRef(onUploadFailed);
	const reportedRef = useRef(new Set<string>());
	const syncRef = useRef<() => void>(() => {});
	const popRef = useRef<PopState | null>(null);
	popRef.current = pop;

	onChangeRef.current = onChange;
	onEnterRef.current = onEnter;
	onFilesRef.current = onFiles;
	onOpenNoteRef.current = onOpenNote;
	onUploadFailedRef.current = onUploadFailed;

	const setShelfBoth = (next: FileChip[]) => {
		shelfRef.current = next;
		setShelf(next);
	};

	const openPopoverAt = (view: EditorView, pos: number) => {
		const node = view.state.doc.nodeAt(pos);
		if (node === null || node.type !== boxSchema.nodes.goblinChip) return;
		const chip = node.attrs.chip as Chip | undefined;
		if (chip === undefined) return;
		const dom = view.nodeDOM(pos);
		if (!(dom instanceof HTMLElement)) return;
		view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
		setPop({ chip, anchor: dom, key: chipKey(chip) });
	};

	syncRef.current = () => {
		const view = viewRef.current;
		if (view === null) return;
		const replacements: { pos: number; size: number; chip: Chip | null }[] = [];
		const failures = new Map<string, string>();
		const fail = (chip: Chip) => {
			const key = chipKey(chip);
			if (reportedRef.current.has(key)) return;
			reportedRef.current.add(key);
			failures.set(key, uploadFailure(chip) ?? "");
		};
		view.state.doc.descendants((node, pos) => {
			if (node.type !== boxSchema.nodes.goblinChip) return;
			const chip = node.attrs.chip as Chip | null;
			if (chip === null) return;
			const next = resolveChip(chip);
			if (next === null) fail(chip);
			if (next !== chip) replacements.push({ pos, size: node.nodeSize, chip: next });
		});
		for (const chip of shelfRef.current) {
			if (resolveChip(chip) === null) fail(chip);
		}
		if (replacements.length > 0) {
			const tr = view.state.tr;
			for (const r of replacements.reverse()) {
				if (r.chip === null) tr.delete(r.pos, r.pos + r.size + extraSpace(view.state.doc, r.pos, r.size));
				else tr.setNodeMarkup(r.pos, null, { chip: r.chip });
			}
			view.dispatch(tr.setMeta("addToHistory", false));
		} else {
			const raw = normalizeDraft({ items: itemsFromDoc(view.state.doc), shelf: shelfRef.current });
			const draft = resolveDraft(raw);
			if (!sameDraft({ items: [], shelf: draft.shelf }, { items: [], shelf: shelfRef.current }))
				setShelfBoth(draft.shelf);
			setShowPlaceholder(draft.items.every((i) => i.type === "text" && i.text.trim() === ""));
			onChangeRef.current?.(draft);
			syncPopover(view);
		}
		for (const message of failures.values()) if (message !== "") onUploadFailedRef.current?.(message);
	};

	const syncPopover = (view: EditorView) => {
		const current = popRef.current;
		if (current !== null) {
			const pos = findChipPos(view, current.key);
			if (pos === null) {
				setPop(null);
			} else {
				const dom = view.nodeDOM(pos);
				if (dom instanceof HTMLElement && dom !== current.anchor) {
					setPop({ ...current, anchor: dom });
				}
			}
		}
	};

	useEffect(() => {
		const wrap = wrapRef.current;
		if (wrap === null) return;
		const state = EditorState.create({
			doc: docFromDraft(initial ?? { items: [], shelf: [] }),
			plugins: [
				history(),
				keymap({ "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo }),
				keymap({
					Enter: (st, _dispatch, view) => {
						if (view === undefined) return false;
						const sel = st.selection;
						if (sel instanceof NodeSelection && sel.node.type === boxSchema.nodes.goblinChip) {
							openPopoverAt(view, sel.from);
							return true;
						}
						if (onEnterRef.current === undefined) return false;
						onEnterRef.current("steer");
						return true;
					},
					"Alt-Enter": (st, dispatch, view) => {
						if (onEnterRef.current === undefined) return splitBlock(st, dispatch, view);
						onEnterRef.current("followUp");
						return true;
					},
					"Shift-Enter": splitBlock,
				}),
				keymap(baseKeymap),
			],
		});
		const view = new EditorView(wrap as unknown as HTMLElement, {
			state,
			attributes: {
				class: "message-box",
				role: "textbox",
				"aria-multiline": "true",
				"aria-label": ariaLabel ?? "Message draft",
				"data-placeholder": placeholder ?? "Message goblin",
			},
			dispatchTransaction: (tr: Transaction) => {
				const v = viewRef.current;
				if (v === null) return;
				v.updateState(v.state.apply(tr));
				syncRef.current();
			},
			handleKeyDown: (_view, event) => {
				return event.key === "Enter" && (event as KeyboardEvent).isComposing === true;
			},
			handleDOMEvents: {
				beforeinput: (view, event) => {
					const e = event as InputEvent;
					const backward = e.inputType === "deleteContentBackward";
					if (!backward && e.inputType !== "deleteContentForward") return false;
					const pos = chipAtDeleteEdge(view, backward);
					if (pos === null) return false;
					const node = view.state.doc.nodeAt(pos);
					if (node === null || node.type !== boxSchema.nodes.goblinChip) return false;
					view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
					e.preventDefault();
					return true;
				},
				click: (view, event) => {
					const target = event.target;
					if (!(target instanceof HTMLElement)) return false;
					const chipEl = target.closest(".goblin-chip");
					if (chipEl === null) return false;
					const pos = view.posAtDOM(chipEl, 0);
					const node = view.state.doc.nodeAt(pos);
					if (node === null || node.type !== boxSchema.nodes.goblinChip) return false;
					openPopoverAt(view, pos);
					event.preventDefault();
					return true;
				},
			},
			handlePaste: (view, event) => {
				const files = Array.from(event.clipboardData?.items ?? []).flatMap((i) =>
					i.kind === "file" ? (i.getAsFile() ?? []) : [],
				);
				if (files.length > 0) {
					onFilesRef.current?.(files);
					return true;
				}
				const data = event.clipboardData;
				const html = data?.getData("text/html") ?? "";
				if (html !== "" && html.includes("data-goblin-chip")) {
					const text = data?.getData("text/plain") ?? "";
					view.dispatch(view.state.tr.replaceSelection(sliceFromChippedHtml(html, text)));
					return true;
				}
				const text = data?.getData("text/plain");
				if (text !== undefined && text !== "") {
					view.dispatch(view.state.tr.replaceSelection(sliceFromPlainText(text)));
					return true;
				}
				return false;
			},
		});
		viewRef.current = view;
		const host = hostRef.current;
		viewBoxes.set(view.dom, view);
		viewBoxes.set(wrap, view);
		if (host !== null) viewBoxes.set(host, view);
		view.dom.addEventListener("focus", () => {
			hadFocusRef.current = true;
		});
		syncRef.current();
		return () => {
			viewBoxes.delete(view.dom);
			viewBoxes.delete(wrap);
			if (host !== null) viewBoxes.delete(host);
			view.destroy();
			viewRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => subscribe(() => syncRef.current()), []);

	const removeChipNodes = (key: string): boolean => {
		const view = viewRef.current;
		if (view === null) return false;
		const positions: number[] = [];
		view.state.doc.descendants((node, pos) => {
			if (node.type === boxSchema.nodes.goblinChip && chipKey(node.attrs.chip as Chip) === key)
				positions.push(pos);
		});
		if (positions.length === 0) return false;
		const tr = view.state.tr;
		for (const pos of positions.reverse()) {
			const node = view.state.doc.nodeAt(pos);
			if (node === null) continue;
			tr.delete(pos, pos + node.nodeSize);
		}
		view.dispatch(tr);
		return true;
	};

	const removeShelfChip = async (chip: FileChip) => {
		const key = chipKey(chip);
		const view = viewRef.current;
		if (view === null) return;
		const mentioned = itemsFromDoc(view.state.doc).some(
			(i) => i.type === "chip" && chipKey(i.chip) === key,
		);
		if (mentioned) {
			const ok = await confirm.ask({
				message: `Remove ${chipName(chip)} from the message too?`,
				confirmLabel: "Remove",
				danger: true,
			});
			if (!ok) return;
		}
		setShelfBoth(shelfRef.current.filter((c) => chipKey(c) !== key));
		if (!removeChipNodes(key)) syncRef.current();
	};

	useImperativeHandle(
		ref,
		() => ({
			getDraft: () => {
				const view = viewRef.current;
				if (view === null) return normalizeDraft({ items: [], shelf: shelfRef.current });
				return resolveDraft(normalizeDraft({ items: itemsFromDoc(view.state.doc), shelf: shelfRef.current }));
			},
			setDraft: (draft: Draft) => {
				const view = viewRef.current;
				if (view === null) return;
				const resolved = normalizeDraft(draft);
				setShelfBoth(resolved.shelf);
				const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, docFromDraft(resolved).content);
				tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, tr.doc.content.size - 1)), -1));
				view.dispatch(tr);
			},
			insertChips: (chips: Chip[]) => {
				const view = viewRef.current;
				if (view === null || chips.length === 0) return;
				for (const chip of chips) {
					const st = view.state;
					const sel = hadFocusRef.current
						? st.selection
						: TextSelection.near(st.doc.resolve(Math.max(0, st.doc.content.size - 1)), -1);
					const { from, to } = sel;
					const before = from > 0 ? st.doc.textBetween(from - 1, from, "\n", "\uFFFC") : "";
					const after =
						to < st.doc.content.size ? st.doc.textBetween(to, to + 1, "\n", "\uFFFC") : "";
					const nodes: PMNode[] = [];
					if (before !== "" && !/^\s$/.test(before)) nodes.push(boxSchema.text(" "));
					nodes.push(boxSchema.nodes.goblinChip.create({ chip }));
					if (after === "" || !/^\s$/.test(after)) nodes.push(boxSchema.text(" "));
					const content = Fragment.fromArray(nodes);
					view.dispatch(
						from < to ? st.tr.replaceWith(from, to, content) : st.tr.insert(from, content),
					);
				}
			},
			prepend: (draft: Draft) => {
				const view = viewRef.current;
				if (view === null) return;
				const resolved = normalizeDraft(draft);
				const incoming = docFromDraft(resolved);
				const current = view.state.doc;
				const currentEmpty =
					current.childCount === 1 && current.child(0).content.size === 0;
				const blocks: PMNode[] = [];
				incoming.forEach((child) => blocks.push(child));
				if (blocks.length > 0 && !currentEmpty && current.content.size > 0)
					blocks.push(boxSchema.nodes.paragraph.create());
				if (!currentEmpty) current.forEach((child) => blocks.push(child));
				view.dispatch(view.state.tr.replaceWith(0, current.content.size, Fragment.fromArray(blocks)));
				if (resolved.shelf.length > 0) {
					const keys = new Set(shelfRef.current.map(chipKey));
					const add = resolved.shelf.filter((chip) => !keys.has(chipKey(chip)));
					if (add.length > 0) setShelfBoth([...shelfRef.current, ...add]);
				}
			},
			appendText: (text: string) => {
				const view = viewRef.current;
				if (view === null || text === "") return;
				const incoming = docFromDraft({ items: [{ type: "text", text }], shelf: [] });
				const blocks: PMNode[] = [];
				view.state.doc.forEach((child) => blocks.push(child));
				incoming.forEach((child) => blocks.push(child));
				view.dispatch(
					view.state.tr.replaceWith(0, view.state.doc.content.size, Fragment.fromArray(blocks)),
				);
			},
			focus: (caret?: "end") => {
				const view = viewRef.current;
				if (view === null) return;
				hadFocusRef.current = true;
				if (caret === "end") {
					const sel = TextSelection.near(
						view.state.doc.resolve(Math.max(0, view.state.doc.content.size - 1)),
						-1,
					);
					view.dispatch(view.state.tr.setSelection(sel));
				}
				view.focus();
			},
		}),
		[],
	);

	return (
		<div className="message-box-host" ref={hostRef}>
			{shelf.length > 0 && (
				<div className="box-shelf" aria-label="Image attachments">
					{shelf.map((chip) => (
						<ShelfThumb
							key={chipKey(chip)}
							chip={chip}
							token={token}
							onUrl={rememberRemoteThumb}
							onRemove={() => void removeShelfChip(chip)}
						/>
					))}
				</div>
			)}
			<div className="message-box-wrap" ref={wrapRef}>
				{showPlaceholder && (
					<span className="box-placeholder" aria-hidden="true">
						{placeholder ?? "Message goblin"}
					</span>
				)}
			</div>
			{pop !== null && (
				<Popover
					open
					onOpenChange={(open) => {
						if (!open) {
							setPop(null);
							viewRef.current?.focus();
						}
					}}
				>
					<PopoverContent
						anchor={pop.anchor}
						align="start"
						sideOffset={6}
						className="chip-pop"
						finalFocus={() => viewRef.current?.dom ?? null}
					>
						<ChipDetails
							chip={pop.chip}
							token={token}
							thumbUrl={
								pop.chip.kind === "file" && pop.chip.state === "ready"
									? (thumbFor(pop.chip) ?? remoteThumbUrls.current.get(pop.chip.ref.path))
									: undefined
							}
							onOpenNote={(id) => onOpenNoteRef.current?.(id)}
							onRemove={() => {
								removeChipNodes(pop.key);
								setPop(null);
								viewRef.current?.focus();
							}}
						/>
					</PopoverContent>
				</Popover>
			)}
			{confirm.view}
		</div>
	);
});

function chipAtDeleteEdge(view: EditorView, backward: boolean): number | null {
	const sel = view.state.selection;
	if (sel instanceof NodeSelection && sel.node.type === boxSchema.nodes.goblinChip) return sel.from;
	const cursor = sel instanceof TextSelection ? sel.$cursor : null;
	if (cursor !== null) {
		const node = backward ? cursor.nodeBefore : cursor.nodeAfter;
		if (node !== null && node !== undefined && node.type === boxSchema.nodes.goblinChip) {
			return backward ? sel.from - node.nodeSize : sel.to;
		}
	}
	const dom = view.dom.ownerDocument.getSelection()?.anchorNode ?? null;
	const el = dom === null ? null : dom.nodeType === 1 ? (dom as HTMLElement) : dom.parentElement;
	const chipEl = el === null ? null : el.closest(".goblin-chip");
	if (chipEl === null || chipEl === undefined) return null;
	const pos = view.posAtDOM(chipEl, 0);
	return view.state.doc.nodeAt(pos)?.type === boxSchema.nodes.goblinChip ? pos : null;
}

function extraSpace(doc: PMNode, pos: number, size: number): number {
	const end = pos + size;
	if (end >= doc.content.size || doc.textBetween(end, end + 1, "\n", "\uFFFC") !== " ") return 0;
	const $pos = doc.resolve(pos);
	if ($pos.parentOffset === 0) return 1;
	return /\s/.test(doc.textBetween(pos - 1, pos, "\n", "\uFFFC")) ? 1 : 0;
}

function findChipPos(view: EditorView, key: string): number | null {
	let found: number | null = null;
	view.state.doc.descendants((node, pos) => {
		if (found !== null) return false;
		if (node.type === boxSchema.nodes.goblinChip && chipKey(node.attrs.chip as Chip) === key) {
			found = pos;
			return false;
		}
		return true;
	});
	return found;
}

function ShelfThumb({
	chip,
	token,
	onUrl,
	onRemove,
}: {
	chip: FileChip;
	token: string | null;
	onUrl?: (path: string, url: string | null) => void;
	onRemove: () => void;
}) {
	const [remote, setRemote] = useState<string | null>(null);
	useEffect(() => {
		if (chip.state !== "ready" || thumbFor(chip) !== undefined) return;
		let live = true;
		let url: string | null = null;
		void fetchAttachmentUrl(token, chip.ref.path).then(
			(u) => {
				if (live) {
					url = u;
					setRemote(u);
					onUrl?.(chip.ref.path, u);
				} else {
					URL.revokeObjectURL(u);
				}
			},
			() => {},
		);
		return () => {
			live = false;
			if (url !== null) URL.revokeObjectURL(url);
			onUrl?.(chip.ref.path, null);
		};
	}, [chip, token, onUrl]);
	const src = thumbFor(chip) ?? (remote ?? undefined);
	return (
		<span className="box-shelf-thumb" data-state={chip.state}>
			{src === undefined ? (
				<span className="box-shelf-empty" aria-hidden="true" />
			) : (
				<img src={src} alt={chip.state === "ready" ? chip.ref.filename : chip.filename} />
			)}
			<button type="button" onClick={onRemove} aria-label={`Remove ${chipName(chip)}`}>
				×
			</button>
		</span>
	);
}

export function ChipDetails({
	chip,
	token,
	thumbUrl,
	onOpenNote,
	onRemove,
	readOnly = false,
}: {
	chip: Chip;
	token: string | null;
	thumbUrl?: string | undefined;
	onOpenNote: (id: string) => void;
	onRemove: () => void;
	readOnly?: boolean | undefined;
}) {
	const [openError, setOpenError] = useState<string | null>(null);
	const [href, setHref] = useState<string | null>(thumbUrl ?? null);
	const navigated = useRef(false);
	const readyFile = chip.kind === "file" && chip.state === "ready";
	const openImage = readyFile && chip.ref.mediaType.startsWith("image/");
	const downloadFile = readyFile && !chip.ref.mediaType.startsWith("image/");
	useEffect(() => {
		navigated.current = false;
		setHref(null);
		if (!openImage) return;
		if (thumbUrl !== undefined) {
			setHref(thumbUrl);
			return;
		}
		if (chip.kind !== "file" || chip.state !== "ready") return;
		let live = true;
		let url: string | null = null;
		void fetchAttachmentUrl(token, chip.ref.path).then(
			(u) => {
				if (live) {
					url = u;
					setHref(u);
				} else {
					URL.revokeObjectURL(u);
				}
			},
			(e: unknown) => {
				if (live) setOpenError(e instanceof Error ? e.message : "download failed");
			},
		);
		return () => {
			live = false;
			if (url !== null && !navigated.current) URL.revokeObjectURL(url);
		};
	}, [openImage, chip, token, thumbUrl]);
	const open = () => {
		if (chip.kind !== "file" || chip.state !== "ready") return;
		const { path, filename } = chip.ref;
		setOpenError(null);
		void fetchAttachmentUrl(token, path).then(
			(u) => {
				const a = document.createElement("a");
				a.href = u;
				if (openImage) {
					a.target = "_blank";
					a.rel = "noopener";
				} else {
					a.download = filename;
				}
				a.click();
				setTimeout(() => URL.revokeObjectURL(u), 60000);
			},
			(e: unknown) => {
				setOpenError(e instanceof Error ? e.message : "download failed");
			},
		);
	};
	return (
		<div className="chip-details">
			<p className="chip-details-name">{chipName(chip)}</p>
			{chip.kind === "file" && (
				<p className="chip-details-meta">
					{chip.state === "ready"
						? `${chip.ref.mediaType} · ${bytes(chip.ref.size)}`
						: `upload ${chip.state}`}
				</p>
			)}
			{chip.kind === "skill" && (
				<p className="chip-details-meta">
					{"name" in chip.ref ? "Skill from your catalog" : `Skill from ${skillHost(chip)}`}
				</p>
			)}
			{openImage && href !== null && (
				<a
					href={href}
					target="_blank"
					rel="noreferrer"
					onClick={() => {
						navigated.current = true;
						setTimeout(() => URL.revokeObjectURL(href), 60000);
					}}
				>
					Open
				</a>
			)}
			{downloadFile && (
				<button type="button" onClick={open}>
					Download
				</button>
			)}
			{chip.kind === "note" && (
				<button type="button" onClick={() => onOpenNote(chip.id)}>
					Open note
				</button>
			)}
			{!readOnly && (
				<button type="button" onClick={onRemove}>
					Remove
				</button>
			)}
			{openError !== null && <p className="chip-details-error">{openError}</p>}
		</div>
	);
}
