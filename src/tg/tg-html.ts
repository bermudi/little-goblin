// Common-markdown → Telegram HTML for the plain delivery path
// (parse_mode "HTML"). Scoped to what model output actually emits:
// fenced code, headings, blockquotes, **bold**, *ital*, `code`,
// ~~strike~~, [links]. Anything unrecognized or left unfinished by a
// chunk boundary renders as literal text — never an invented entity;
// a rejected send still falls back to plain text upstream.
//
// Chunking is chunkWindows' job (delivery-text.ts): it closes a fence
// at a window's end and reopens it with the same info string on the
// next, so every window rendered here is self-contained — no state
// crosses the boundary. The fence-opener rule is shared with the
// chunker through the fenceOpen import — one grammar, one regex.

import { fenceOpen } from "./delivery-text.ts";

const LANG = /^[A-Za-z0-9_+.-]+/;

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
	return escapeHtml(text).replace(/"/g, "&quot;");
}

// Find `delim` at or after `from` such that the char before it is not
// whitespace (approximate CommonMark right-flanking). -1 when none.
function findClosing(s: string, delim: string, from: number): number {
	let at = s.indexOf(delim, from);
	while (at !== -1) {
		if (at > from && !/\s/.test(s[at - 1]!)) return at;
		at = s.indexOf(delim, at + 1);
	}
	return -1;
}

// A single-char delimiter (*, _) can't close inside a longer run —
// the `*` of "**" is part of a different token.
function findClosingSingle(s: string, ch: string, from: number): number {
	let at = s.indexOf(ch, from);
	while (at !== -1) {
		if (at > from && s[at - 1] !== ch && s[at + 1] !== ch && !/\s/.test(s[at - 1]!)) return at;
		at = s.indexOf(ch, at + 1);
	}
	return -1;
}

// The ')' that balances the '(' opening a link destination —
// CommonMark allows balanced parens in the URL.
function balancedParen(s: string, from: number): number {
	let depth = 1;
	for (let k = from; k < s.length; k++) {
		if (s[k] === "(") depth++;
		else if (s[k] === ")") {
			depth--;
			if (depth === 0) return k;
		}
	}
	return -1;
}

const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

function renderInline(s: string): string {
	let out = "";
	let i = 0;
	while (i < s.length) {
		const c = s[i]!;
		if (c === "`") {
			let run = 1;
			while (s[i + run] === "`") run++;
			const close = s.indexOf("`".repeat(run), i + run);
			if (close !== -1) {
				out += `<code>${escapeHtml(s.slice(i + run, close))}</code>`;
				i = close + run;
				continue;
			}
			out += "`".repeat(run);
			i += run;
			continue;
		}
		if (c === "*" && s[i + 1] === "*" && s[i + 2] === "*") {
			if (s[i + 3] !== undefined && !/\s/.test(s[i + 3]!)) {
				const close = findClosing(s, "***", i + 3);
				if (close !== -1) {
					out += `<b><i>${renderInline(s.slice(i + 3, close))}</i></b>`;
					i = close + 3;
					continue;
				}
			}
			out += "***";
			i += 3;
			continue;
		}
		if (c === "*" && s[i + 1] === "*") {
			if (s[i + 2] !== undefined && !/\s/.test(s[i + 2]!)) {
				const close = findClosing(s, "**", i + 2);
				if (close !== -1) {
					out += `<b>${renderInline(s.slice(i + 2, close))}</b>`;
					i = close + 2;
					continue;
				}
			}
			out += "**";
			i += 2;
			continue;
		}
		if (c === "_" && s[i + 1] === "_") {
			if (!isWord(s[i - 1]) && s[i + 2] !== undefined && !/\s/.test(s[i + 2]!)) {
				const close = s.indexOf("__", i + 2);
				if (close !== -1 && !isWord(s[close + 2])) {
					out += `<b>${renderInline(s.slice(i + 2, close))}</b>`;
					i = close + 2;
					continue;
				}
			}
			out += "__";
			i += 2;
			continue;
		}
		if (c === "*") {
			if (s[i + 1] !== undefined && !/\s/.test(s[i + 1]!)) {
				const close = findClosingSingle(s, "*", i + 1);
				if (close !== -1) {
					out += `<i>${renderInline(s.slice(i + 1, close))}</i>`;
					i = close + 1;
					continue;
				}
			}
			out += "*";
			i += 1;
			continue;
		}
		if (c === "_") {
			if (!isWord(s[i - 1]) && s[i + 1] !== undefined && !/\s/.test(s[i + 1]!)) {
				const close = findClosingSingle(s, "_", i + 1);
				if (close !== -1 && !isWord(s[close + 1])) {
					out += `<i>${renderInline(s.slice(i + 1, close))}</i>`;
					i = close + 1;
					continue;
				}
			}
			out += "_";
			i += 1;
			continue;
		}
		if (c === "~" && s[i + 1] === "~") {
			if (s[i + 2] !== undefined && !/\s/.test(s[i + 2]!)) {
				const close = findClosing(s, "~~", i + 2);
				if (close !== -1) {
					out += `<s>${renderInline(s.slice(i + 2, close))}</s>`;
					i = close + 2;
					continue;
				}
			}
			out += "~~";
			i += 2;
			continue;
		}
		// [text](url) and ![alt](url) — the first ']' ends the label,
		// so earlier brackets stay literal; a balanced-paren URL keeps
		// its inner parens; a link the URL refuses stays literal.
		if (c === "[" || (c === "!" && s[i + 1] === "[")) {
			const img = c === "!";
			const open = img ? i + 1 : i;
			const closeText = s.indexOf("]", open + 1);
			if (closeText !== -1 && s[closeText + 1] === "(") {
				const closeParen = balancedParen(s, closeText + 2);
				if (closeParen !== -1) {
					const url = s.slice(closeText + 2, closeParen).trim();
					if (url !== "" && !/[\s<>"']/.test(url)) {
						const label = s.slice(open + 1, closeText);
						const shown = label === "" ? (img ? "image" : url) : label;
						out += `<a href="${escapeAttr(url)}">${renderInline(shown)}</a>`;
						i = closeParen + 1;
						continue;
					}
				}
			}
			out += escapeHtml(c);
			i += 1;
			continue;
		}
		out += escapeHtml(c);
		i += 1;
	}
	return out;
}

export function renderTelegramHtml(src: string): string {
	const out: string[] = [];
	let fence: { marker: string; info: string } | null = null;
	let pre: string[] | null = null;
	let quote: string[] | null = null;
	const closeQuote = () => {
		if (quote !== null) {
			out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
			quote = null;
		}
	};
	const closePre = () => {
		if (pre !== null && pre.length > 0) {
			const lang = fence !== null ? LANG.exec(fence.info)?.[0] : undefined;
			const inner =
				lang !== undefined
					? `<code class="language-${escapeAttr(lang)}">${pre.join("\n")}</code>`
					: pre.join("\n");
			out.push(`<pre>${inner}</pre>`);
		}
		pre = null;
		fence = null;
	};
	for (const line of src.split("\n")) {
		if (fence !== null) {
			const open = fenceOpen(line);
			// A closer is a bare marker run — same char, at least the
			// opener's length, no info — anything else is code content.
			if (open !== null && open.info === "" && open.marker.startsWith(fence.marker)) {
				closePre();
			} else {
				pre!.push(escapeHtml(line));
			}
			continue;
		}
		const open = fenceOpen(line);
		if (open !== null) {
			closeQuote();
			fence = open;
			pre = [];
			continue;
		}
		const quoteMatch = /^>[ \t]?(.*)$/.exec(line);
		if (quoteMatch !== null) {
			(quote ??= []).push(renderInline(quoteMatch[1]!));
			continue;
		}
		closeQuote();
		const heading = /^#{1,6}[ \t]+(.*)$/.exec(line);
		if (heading !== null) {
			out.push(`<b>${renderInline(heading[1]!)}</b>`);
			continue;
		}
		out.push(renderInline(line));
	}
	closeQuote();
	// A fence left open at the window's end still produces closed
	// markup — a window that ends mid-fence keeps Telegram-parsable
	// output even before the next window arrives.
	closePre();
	return out.join("\n");
}
