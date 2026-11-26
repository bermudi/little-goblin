// Select-to-quote: the selection pill, quote-draft formatting, and
// speaker attribution.

import { useEffect, useState, type RefObject } from "react";


// Who wrote a quoted selection. The annotation names the retention
// document's speaker labels (Operator/Goblin) so both readers — Goblin
// in chat and memory extraction — see whose words the blockquote holds;
// unattributed quotes used to extract as the operator's own statements
// (#182).
export type QuoteSpeaker = "user" | "assistant";

export function quoteButtonPosition({
	lineRects,
	pointer,
	viewport,
	bounds,
}: {
	lineRects: DOMRect[];
	pointer: { x: number; y: number } | null;
	viewport: { width: number; height: number };
	bounds: DOMRect;
}): { x: number; y: number } | null {
	if (lineRects.length === 0) return null;
	const last = lineRects[lineRects.length - 1] as DOMRect;
	const first = lineRects[0] as DOMRect;
	const follows = pointer !== null && lineRects.some((r) =>
		pointer.x >= r.left - 8 && pointer.x <= r.right + 8 &&
		pointer.y >= r.top - 8 && pointer.y <= r.bottom + 8,
	);
	const minX = bounds.left + 8;
	const maxX = Math.min(bounds.right, viewport.width) - 8 - 72;
	const x = Math.min(Math.max(follows ? pointer.x : last.right, minX), maxX);
	let y = last.bottom + 6;
	const maxY = Math.min(bounds.bottom, viewport.height) - 8 - 32;
	y = Math.min(Math.max(y, bounds.top + 8), maxY);
	if (lineRects.some((r) => y < r.bottom && y + 32 > r.top)) {
		y = first.top - 6 - 32;
	}
	return { x, y };
}

export function quoteSourceNote(speaker: QuoteSpeaker): string {
	return speaker === "assistant"
		? "[quoting Goblin's earlier reply]"
		: "[quoting the operator's earlier message]";
}

export function quoteBlock(text: string, speaker?: QuoteSpeaker): string {
	const block = text
		.trim()
		.split("\n")
		.map((l) => (l.trim() === "" ? ">" : `> ${l}`))
		.join("\n");
	return speaker === undefined ? block : `${quoteSourceNote(speaker)}\n${block}`;
}

export function appendQuote(draft: string, text: string, speaker?: QuoteSpeaker): string {
	const quoted = quoteBlock(text, speaker);
	const head = draft.trimEnd();
	return head === "" ? `${quoted}\n\n` : `${head}\n\n${quoted}\n\n`;
}

// The selection's element, or null with no selection — used both to
// keep the pill inside the transcript and to find the quoted bubble.
function selectionElement(sel: Selection | null): Element | null {
	if (sel === null || sel.rangeCount === 0) return null;
	const node = sel.getRangeAt(0).commonAncestorContainer;
	return node instanceof Element ? node : node.parentElement;
}

// Speaker of a quoted selection: the message bubble's class says who
// wrote it. No bubble — a selection across messages or in transcript
// chrome — has no speaker; that quote lands unattributed, as before.
export function quoteSpeaker(el: Element | null): QuoteSpeaker | null {
	const msg = el?.closest(".msg") ?? null;
	if (msg?.classList.contains("user")) return "user";
	if (msg?.classList.contains("assistant")) return "assistant";
	return null;
}

export function QuoteFab({
	root,
	onQuote,
}: {
	root: RefObject<HTMLElement | null>;
	onQuote: (text: string, speaker: QuoteSpeaker | null, messageId: string | null) => void;
}) {
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	useEffect(() => {
		let pointer: { x: number; y: number } | null = null;
		let heldMouse = false;
		let hiddenByEscape = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const update = () => {
			const sel = document.getSelection();
			const el = root.current;
			if (
				sel === null ||
				el === null ||
				sel.isCollapsed ||
				sel.rangeCount === 0 ||
				sel.toString().trim() === ""
			) {
				setPos(null);
				return;
			}
			const range = sel.getRangeAt(0);
			const container = selectionElement(sel);
			if (container === null || !el.contains(container)) {
				setPos(null);
				return;
			}
			const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0);
			if (rects.length === 0 || rects.every((rect) => rect.bottom < 0 || rect.top > window.innerHeight)) {
				setPos(null);
				return;
			}
			const next = quoteButtonPosition({ lineRects: rects, pointer, viewport: { width: window.innerWidth, height: window.innerHeight }, bounds: el.getBoundingClientRect() });
			if (heldMouse || hiddenByEscape) setPos(null);
			else setPos(next);
		};
		const pointerDown = (event: PointerEvent) => {
			if (event.pointerType === "touch") pointer = null;
			if (event.pointerType === "mouse" && event.button === 0 && root.current?.contains(event.target as Node)) {
				heldMouse = true;
				pointer = { x: event.clientX, y: event.clientY };
				setPos(null);
			}
		};
		const pointerUp = (event: PointerEvent) => {
			if (event.pointerType !== "mouse" || !heldMouse) return;
			heldMouse = false;
			pointer = { x: event.clientX, y: event.clientY };
			update();
		};
		const keyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") { hiddenByEscape = true; setPos(null); }
			else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
				pointer = null;
				hiddenByEscape = false;
			}
		};
		const scroll = () => {
			setPos(null);
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => update(), 150);
		};
		const repeatedClick = (event: MouseEvent) => {
			if (event.detail >= 2 && root.current?.contains(event.target as Node)) { pointer = null; update(); }
		};
		const selectionChange = () => {
			hiddenByEscape = false;
			update();
		};
		document.addEventListener("selectionchange", selectionChange);
		document.addEventListener("pointerdown", pointerDown);
		document.addEventListener("pointerup", pointerUp);
		document.addEventListener("keydown", keyDown);
		document.addEventListener("click", repeatedClick);
		window.addEventListener("resize", update);
		const el = root.current;
		el?.addEventListener("scroll", scroll);
		return () => {
			document.removeEventListener("selectionchange", selectionChange);
			document.removeEventListener("pointerdown", pointerDown);
			document.removeEventListener("pointerup", pointerUp);
			document.removeEventListener("keydown", keyDown);
			document.removeEventListener("click", repeatedClick);
			window.removeEventListener("resize", update);
			el?.removeEventListener("scroll", scroll);
			if (timer !== null) clearTimeout(timer);
		};
	}, [root]);
	if (pos === null) return null;
	return (
		<button
			type="button"
			className="quote-fab"
			style={{
				left: pos.x,
				top: pos.y,
			}}
			onPointerDown={(e) => e.preventDefault()}
			onClick={() => {
				const sel = document.getSelection();
				const text = sel === null ? "" : sel.toString();
				const speaker = quoteSpeaker(selectionElement(sel));
				const messageId = selectionElement(sel)?.closest(".msg")?.getAttribute("data-message-id") ?? null;
				sel?.removeAllRanges();
				setPos(null);
				if (text.trim() !== "") onQuote(text, speaker, messageId);
			}}
		>
			Quote
		</button>
	);
}
