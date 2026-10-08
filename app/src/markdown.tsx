// Transcript markdown — a small block renderer over the shapes a chat
// model actually emits: ATX headings, fenced code, blockquotes, lists
// (bullets, ordered, checkboxes, one level of indent), pipe tables,
// paragraphs. Inline: links, code spans, bold, italic, strike, bare
// URLs. This is comfortable reading, not CommonMark conformance —
// anything unrecognized stays literal text.

import { useMemo, type ReactNode } from "react";
import { useCopy } from "./useCopy.ts";
// core + the languages a chat model actually fences — the /common bundle
// is ~40 grammars of COBOL the bundle doesn't need.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import lua from "highlight.js/lib/languages/lua";
import markdownLang from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("markdown", markdownLang);
hljs.registerLanguage("php", php);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

// The link alternative must lead: it swallows the URL inside its own
// parens before the bare-URL branch can split it. ** leads * so
// `**bold**` never halves into `*…*`; emphasis content may not
// start/end in whitespace, so `2 * 3 * 4` stays literal; `_` only
// opens/closes on non-word edges so snake_case identifiers stay
// literal.
const INLINE =
	/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^\s*](?:[^\n]*?[^\s*])?)\*\*|\*([^\s*](?:[^\n]*?[^\s*])?)\*|(?<![\w*])_([^\s_](?:[^\n]*?[^\s_])?)_(?!\w)|~~([^\s~](?:[^\n]*?[^\s~])?)~~|(https?:\/\/[^\s<>"')\]]+)/g;

export function inline(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let i = 0;
	for (const m of text.matchAll(INLINE)) {
		if (m.index > last) out.push(text.slice(last, m.index));
		if (m[1] !== undefined)
			out.push(
				<a key={i} href={m[2]} target="_blank" rel="noreferrer">
					{m[1]}
				</a>,
			);
		else if (m[3] !== undefined) out.push(<code key={i}>{m[3]}</code>);
		else if (m[4] !== undefined) out.push(<strong key={i}>{m[4]}</strong>);
		else if (m[5] !== undefined) out.push(<em key={i}>{m[5]}</em>);
		else if (m[6] !== undefined) out.push(<em key={i}>{m[6]}</em>);
		else if (m[7] !== undefined) out.push(<s key={i}>{m[7]}</s>);
		else
			out.push(
				<a key={i} href={m[8]} target="_blank" rel="noreferrer">
					{m[8]}
				</a>,
			);
		last = m.index + m[0].length;
		i++;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

// Fenced block → a card: mono language label, copy button, then the
// code with syntax coloring. An unknown language falls back to plain
// text — a model's made-up fence tag must never blank the code.
function CodeBlock({ lang, code }: { lang: string; code: string }) {
	const { copied, copy } = useCopy();
	// highlight() throws on a grammar bug or unregistered language —
	// hljs escapes markup in its output, so the value is safe HTML.
	const html = useMemo(() => {
		const language = lang.split(/\s/, 1)[0] ?? "";
		if (language !== "" && hljs.getLanguage(language)) {
			try {
				return hljs.highlight(code, { language, ignoreIllegals: true }).value;
			} catch {
				return null;
			}
		}
		return null;
	}, [lang, code]);
	return (
		<div className="codeblock">
			<div className="codeblock-head">
				<span className="codeblock-lang">{lang === "" ? "text" : lang}</span>
				<button type="button" className="codeblock-copy" onClick={() => copy(code)}>
					{copied ? "✓" : "copy"}
				</button>
			</div>
			<pre>
				{html === null ? (
					<code>{code}</code>
				) : (
					<code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
				)}
			</pre>
		</div>
	);
}

// One list item line: indent (2 spaces per level), marker, optional
// checkbox, then the text. Ordered markers keep their number only to
// decide the <ol> — items render their own position.
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/;
// GFM pipe table: a row of cells, then a `---` separator row.
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?[\s|:.-]*$/;

function splitRow(line: string): string[] {
	// Strip the outer pipes, then split — escaped \| inside a cell is
	// rare enough to leave literal.
	const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return t.split("|").map((c) => c.trim());
}

interface ListItem {
	depth: number;
	ordered: boolean;
	checked: boolean | null;
	text: string;
}

export function Markdown({ text }: { text: string }) {
	const blocks: ReactNode[] = [];
	const lines = text.split("\n");
	let i = 0;
	let key = 0;
	// Accumulated paragraph text — flushed on a blank line or a block.
	let para: string[] = [];
	const flushPara = () => {
		if (para.length === 0) return;
		const body = para.join("\n").trim();
		para = [];
		if (body !== "") blocks.push(<p key={key++}>{inline(body)}</p>);
	};

	while (i < lines.length) {
		const line = lines[i]!;

		// Fenced code — ```lang … ``` (an unclosed fence runs to EOF).
		const fence = line.match(/^```([^\n`]*)$/);
		if (fence) {
			flushPara();
			const lang = (fence[1] ?? "").trim();
			const codeLines: string[] = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
				codeLines.push(lines[i]!);
				i++;
			}
			if (i < lines.length) i++; // consume the closing fence
			blocks.push(<CodeBlock key={key++} lang={lang} code={codeLines.join("\n")} />);
			continue;
		}

		// ATX heading.
		const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (heading) {
			flushPara();
			const level = Math.min(heading[1]!.length + 1, 6);
			const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
			blocks.push(
				<Tag key={key++} className="md-h">
					{inline(heading[2]!)}
				</Tag>,
			);
			i++;
			continue;
		}

		// Horizontal rule.
		if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			flushPara();
			blocks.push(<hr key={key++} className="md-hr" />);
			i++;
			continue;
		}

		// Blockquote — consecutive `>` lines become their own markdown
		// block (a quote can hold a list or a heading).
		if (/^\s*>/.test(line)) {
			flushPara();
			const quote: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i]!)) {
				quote.push(lines[i]!.replace(/^\s*>\s?/, ""));
				i++;
			}
			blocks.push(
				<blockquote key={key++} className="md-quote">
					<Markdown text={quote.join("\n")} />
				</blockquote>,
			);
			continue;
		}

		// Pipe table — header row, separator row, body rows.
		if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
			flushPara();
			const header = splitRow(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
				rows.push(splitRow(lines[i]!));
				i++;
			}
			blocks.push(
				<table key={key++} className="md-table">
					<thead>
						<tr>
							{header.map((h, c) => (
								<th key={c}>{inline(h)}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((r, ri) => (
							<tr key={ri}>
								{r.map((c, ci) => (
									<td key={ci}>{inline(c)}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>,
			);
			continue;
		}

		// List — consecutive item lines; depth is indent/2, list kind is
		// per-item so a model mixing - and 1. still renders sanely.
		if (ITEM.test(line)) {
			flushPara();
			const items: ListItem[] = [];
			while (i < lines.length && ITEM.test(lines[i]!)) {
				const m = ITEM.exec(lines[i]!)!;
				items.push({
					depth: Math.floor(m[1]!.length / 2),
					ordered: /^\d/.test(m[2]!),
					checked: m[3] === undefined ? null : m[3].toLowerCase() === "x",
					text: m[4]!,
				});
				i++;
			}
			blocks.push(<ListTree key={key++} items={items} />);
			continue;
		}

		if (line.trim() === "") {
			flushPara();
			i++;
			continue;
		}
		para.push(line);
		i++;
	}
	flushPara();
	return <>{blocks}</>;
}

// Items → a nested list tree. Each frame is the open list at a depth;
// a deeper item starts a child list under the last item, a shallower
// one closes frames until it fits.
function ListTree({ items }: { items: ListItem[] }) {
	interface Node {
		item: ListItem;
		kids: Node[];
	}
	const roots: Node[] = [];
	// path: the parent chain — path[d] is the node nested items at
	// depth d+1 attach under.
	const path: Node[] = [];
	for (const item of items) {
		const node: Node = { item, kids: [] };
		const depth = Math.min(item.depth, path.length);
		if (depth === 0) roots.push(node);
		else path[depth - 1]!.kids.push(node);
		path.length = depth;
		path[depth] = node;
	}
	const render = (nodes: Node[]): ReactNode => {
		const ordered = nodes[0]?.item.ordered === true;
		const inner = nodes.map((n, i) => (
			<li key={i} className={n.item.checked !== null ? "md-task" : undefined}>
				{n.item.checked !== null && (
					<span className="md-check" aria-hidden>
						{n.item.checked ? "☑" : "☐"}
					</span>
				)}
				{inline(n.item.text)}
				{n.kids.length > 0 && render(n.kids)}
			</li>
		));
		return ordered ? <ol className="md-list">{inner}</ol> : <ul className="md-list">{inner}</ul>;
	};
	return <>{render(roots)}</>;
}
