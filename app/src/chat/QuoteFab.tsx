// Select-to-quote: the selection pill, quote-draft formatting, and
// speaker attribution.

import { useEffect, useState, type RefObject } from "react";


// Who wrote a quoted selection. The annotation names the retention
// document's speaker labels (Operator/Goblin) so both readers — Goblin
// in chat and memory extraction — see whose words the blockquote holds;
// unattributed quotes used to extract as the operator's own statements
// (#182).
export type QuoteSpeaker = "user" | "assistant";

export function quoteSourceNote(speaker: QuoteSpeaker): string {
	return speaker === "assistant"
		? "[quoting Goblin's earlier reply]"
		: "[quoting the operator's earlier message]";
}

// A quote goes into the draft as a markdown blockquote — appended, never
// replaced, so one reply can collect quotes from several sections of a
// message. A known speaker lands as an annotation line above the block
// (the proven #182 layout: blockquote on its own line, source named
// above it). Trailing blank line lands the cursor under the block,
// ready to type the answer.
export function appendQuote(draft: string, text: string, speaker?: QuoteSpeaker): string {
	const block = text
		.trim()
		.split("\n")
		.map((l) => (l.trim() === "" ? ">" : `> ${l}`))
		.join("\n");
	const quoted = speaker === undefined ? block : `${quoteSourceNote(speaker)}\n${block}`;
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

// Selection → quote: a pill parked at the selection's rect while a
// non-collapsed selection lives inside the transcript. The browser owns
// the selection (native callout included) — we only read it; the
// pointerdown preventDefault keeps the click from collapsing it first.
export function QuoteFab({
	root,
	onQuote,
}: {
	root: RefObject<HTMLElement | null>;
	onQuote: (text: string, speaker: QuoteSpeaker | null) => void;
}) {
	const [pos, setPos] = useState<{ x: number; y: number; above: boolean } | null>(null);
	useEffect(() => {
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
			const rect = range.getBoundingClientRect();
			if (rect.bottom < 0 || rect.top > window.innerHeight) {
				setPos(null);
				return;
			}
			const x = Math.min(Math.max(rect.left + rect.width / 2, 48), window.innerWidth - 48);
			setPos(
				rect.top > 44
					? { x, y: rect.top - 8, above: true }
					: { x, y: rect.bottom + 8, above: false },
			);
		};
		document.addEventListener("selectionchange", update);
		window.addEventListener("resize", update);
		const el = root.current;
		el?.addEventListener("scroll", update);
		return () => {
			document.removeEventListener("selectionchange", update);
			window.removeEventListener("resize", update);
			el?.removeEventListener("scroll", update);
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
				transform: pos.above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
			}}
			onPointerDown={(e) => e.preventDefault()}
			onClick={() => {
				const sel = document.getSelection();
				const text = sel === null ? "" : sel.toString();
				const speaker = quoteSpeaker(selectionElement(sel));
				sel?.removeAllRanges();
				setPos(null);
				if (text.trim() !== "") onQuote(text, speaker);
			}}
		>
			Quote
		</button>
	);
}
