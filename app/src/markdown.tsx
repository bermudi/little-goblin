// Transcript markdown — comfortable reading, not CommonMark
// conformance: anything unrecognized stays literal text.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCopy } from "./useCopy.ts";
import { appendNote, createNote, listNotes } from "./api.ts";
import type { AppNoteSummary } from "../../src/http/app-wire.ts";
// Machinery-speech spellings have one owner; the transcript renders
// their prefix, it doesn't re-spell it.
import { isMachineryText } from "../../src/tags.ts";
// core + the languages a chat model actually fences — the /common
// bundle is ~40 grammars the client doesn't need.
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

// clipFences opt-in: a fence longer than CLIP_MIN clips to CLIP_LINES
// plus a show-all tail — operator pastes would otherwise own the
// transcript.
const CLIP_MIN = 20;
const CLIP_LINES = 15;

// An unknown language falls back to plain text — a model's made-up
// fence tag must never blank the code.
function CodeBlock({
	lang,
	code,
	clip,
}: {
	lang: string;
	code: string;
	clip?: boolean | undefined;
}) {
	const { copied, failed, copy } = useCopy();
	const [open, setOpen] = useState(false);
	const lines = code.split("\n").length;
	const clipped = clip === true && lines > CLIP_MIN;
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
				<button
					type="button"
					className="codeblock-copy"
					aria-label={failed ? "Copy failed" : undefined}
					aria-live="polite"
					onClick={() => copy(code)}
				>
					{copied ? "✓" : failed ? "copy failed" : "copy"}
				</button>
			</div>
			<div className="codeblock-body">
				{/* The cap is a visual clip, not a cut — the pre always holds the
				    full code so copy and select-all stay honest. lh resolves
				    against the pre's own line-height and --codeblock-pad-b its
				    bottom padding, so styles.css keeps owning both metrics. */}
				<pre
					className={clipped && !open ? "clip" : undefined}
					style={
						clipped && !open
							? { maxHeight: `calc(${CLIP_LINES}lh + var(--codeblock-pad-b))` }
							: undefined
					}
				>
					{html === null ? (
						<code>{code}</code>
					) : (
						<code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
					)}
				</pre>
				{clipped && !open && <div className="codeblock-fade" />}
			</div>
			{clipped && (
				<button
					type="button"
					className="codeblock-more"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
				>
					{open ? "show less" : `show all ${lines} lines`}
				</button>
			)}
		</div>
	);
}

// Ordered markers keep their number only to decide the <ol> — items
// render their own position.
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/;
// GFM pipe-table separator row.
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

// A `note` info-string fence — the convention the system prompt names:
// its body is note-ready content the card offers to append somewhere
// real. `title="…"` prenames a new note; appending to an existing one
// keeps its title.
function NoteAppendCard({
	title,
	body,
	token,
	noteProjectId,
	onOpenNote,
	unfinished,
	streaming,
	clipFences,
}: {
	title: string | null;
	body: string;
	token: string | null;
	// A project-bound conversation files new notes in its project.
	noteProjectId?: string | null | undefined;
	onOpenNote?: ((id: string) => void) | undefined;
	// The fence never closed — the body may be a prefix. It only
	// withholds the append affordance while the message is still
	// streaming; once settled (or reloaded from history) this prefix
	// is all there is, so the affordance shows.
	unfinished?: boolean | undefined;
	// The message this card lives in is still arriving.
	streaming?: boolean | undefined;
	clipFences?: boolean | undefined;
}) {
	const [open, setOpen] = useState(false);
	const [notes, setNotes] = useState<AppNoteSummary[] | null>(null);
	// The wire's hit-the-bound bit — a capped list must say so, not
	// read as complete (same contract as the notes index).
	const [truncated, setTruncated] = useState(false);
	const [listFailed, setListFailed] = useState(false);
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState<"idle" | "busy" | "done" | "error">("idle");
	const [done, setDone] = useState<{ id: string; title: string; created: boolean } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const searchSeq = useRef(0);

	useEffect(() => {
		if (!open) return;
		const seq = ++searchSeq.current;
		const t = setTimeout(() => {
			void listNotes(token, { project: "all", q: query }).then(
				(r) => {
					if (seq !== searchSeq.current) return;
					setNotes(r.notes);
					setTruncated(r.truncated);
					setListFailed(false);
				},
				() => {
					if (seq !== searchSeq.current) return;
					setNotes([]);
					setListFailed(true);
				},
			);
		}, 200);
		return () => clearTimeout(t);
	}, [open, query, token]);

	const append = (id: string) => {
		setStatus("busy");
		setError(null);
		void appendNote(token, id, body).then(
			(n) => {
				setStatus("done");
				setDone({ id: n.id, title: n.title, created: false });
			},
			(err: unknown) => {
				setStatus("error");
				setError(err instanceof Error ? err.message : "append failed");
			},
		);
	};
	const create = () => {
		setStatus("busy");
		setError(null);
		void createNote(token, {
			title: title ?? "untitled",
			body,
			...(noteProjectId != null ? { projectId: noteProjectId } : {}),
		}).then(
			(n) => {
				setStatus("done");
				setDone({ id: n.id, title: n.title, created: true });
			},
			(err: unknown) => {
				setStatus("error");
				setError(err instanceof Error ? err.message : "create failed");
			},
		);
	};

	return (
		<div className="note-card">
			<div className="note-card-head">
				<span className="note-card-tag">note{title !== null ? ` — ${title}` : ""}</span>
			</div>
			<div className="note-card-body">
				<Markdown
					text={body}
					token={token}
					noteProjectId={noteProjectId}
					onOpenNote={onOpenNote}
					streaming={streaming}
					clipFences={clipFences}
				/>
			</div>
			{unfinished === true && streaming === true ? null : status === "done" ? (
				<p className="note-card-status">
					{done!.created ? "Created" : "Appended to"}{" "}
					<button type="button" className="link" onClick={() => onOpenNote?.(done!.id)}>
						{done!.title}
					</button>
					.
				</p>
			) : open ? (
				<div className="note-pick">
					<input
						type="search"
						placeholder="Search notes"
						value={query}
						autoFocus
						onChange={(e) => setQuery(e.target.value)}
					/>
					{listFailed && <p className="error">Couldn't list notes.</p>}
					<ul>
						{(notes ?? []).map((n) => (
							<li key={n.id}>
								<button type="button" disabled={status === "busy"} onClick={() => append(n.id)}>
									{n.title}
								</button>
							</li>
						))}
						<li>
							<button type="button" disabled={status === "busy"} onClick={create}>
								{title === null ? "New note" : `New note “${title}”`}
							</button>
						</li>
					</ul>
					{truncated && notes !== null && notes.length > 0 && (
						<p className="empty" role="status">
							Showing the first {notes.length} matching notes — narrow the search to find the rest.
						</p>
					)}
				</div>
			) : (
				<button
					type="button"
					className="note-card-append"
					onClick={() => {
						setOpen(true);
						setError(null);
					}}
				>
					Append to note…
				</button>
			)}
			{status === "error" && <p className="error">Couldn't write the note: {error}</p>}
		</div>
	);
}

// What a `note` fence card needs from its host: the caller's auth, the
// conversation's project (a card-created note binds to it), and note
// navigation — threaded through every markdown-rendering container.
export interface MarkdownNoteContext {
	// An unfinished note fence cannot append until its stream settles.
	streaming?: boolean | undefined;
	token?: string | null | undefined;
	noteProjectId?: string | null | undefined;
	onOpenNote?: ((id: string) => void) | undefined;
}

export function Markdown({
	text,
	token,
	noteProjectId,
	onOpenNote,
	streaming,
	clipFences,
}: {
	text: string;
	// Host opt-in: long fences clip to a preview with a show-all tail.
	clipFences?: boolean | undefined;
} & MarkdownNoteContext) {
	const blocks: ReactNode[] = [];
	const lines = text.split("\n");
	let i = 0;
	let key = 0;
	let para: string[] = [];
	const flushPara = () => {
		if (para.length === 0) return;
		const body = para.join("\n").trim();
		para = [];
		if (body !== "") blocks.push(<p key={key++}>{inline(body)}</p>);
	};

	while (i < lines.length) {
		const line = lines[i]!;

		// Fenced code — a run of 3+ backticks whose closer is at least
		// as long (so a ```note card can hold ``` blocks intact). An
		// unclosed fence runs to EOF.
		const fence = line.match(/^(`{3,})([^\n`]*)$/);
		if (fence) {
			flushPara();
			const ticks = fence[1]!.length;
			const info = (fence[2] ?? "").trim();
			const codeLines: string[] = [];
			const closing = new RegExp(`^\\\`{${ticks},}\\s*$`);
			i++;
			while (i < lines.length && !closing.test(lines[i]!)) {
				codeLines.push(lines[i]!);
				i++;
			}
			const closed = i < lines.length;
			if (closed) i++; // consume the closing fence
			const body = codeLines.join("\n");
			// A `note` fence (the prompt's append convention) renders as a
			// card — content plus the append affordance, never code. An
			// unclosed fence mid-stream is a prefix: the card shows but
			// its affordance waits for the stream to settle.
			if (info === "note" || info.startsWith("note ")) {
				const titled = /^note\s+title="([^"]*)"\s*$/.exec(info);
				const bare = info === "note";
				if (bare || titled !== null) {
					blocks.push(
						<NoteAppendCard
							key={key++}
							title={titled?.[1] ?? null}
							body={body}
							token={token ?? null}
							noteProjectId={noteProjectId}
							onOpenNote={onOpenNote}
							unfinished={!closed}
							streaming={streaming}
							clipFences={clipFences}
						/>,
					);
					continue;
				}
			}
			blocks.push(<CodeBlock key={key++} lang={info} code={body} clip={clipFences} />);
			continue;
		}

		// A machinery tag line ([delegation: …], [program: …]) opens an
		// event notice — machine speech, not transcript prose. Fenced at
		// a block start, it reads as the envelope it is; any prose that
		// follows in the same paragraph still renders as text.
		if (para.length === 0 && isMachineryText(line)) {
			blocks.push(<CodeBlock key={key++} lang="status" code={line.trim()} />);
			i++;
			continue;
		}

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
					<Markdown
						text={quote.join("\n")}
						token={token}
						noteProjectId={noteProjectId}
						onOpenNote={onOpenNote}
						streaming={streaming}
						clipFences={clipFences}
					/>
				</blockquote>,
			);
			continue;
		}

		if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
			flushPara();
			const header = splitRow(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
				rows.push(splitRow(lines[i]!));
				i++;
			}
		// The wrapper owns horizontal overflow — an unbreakable cell
		// (a sha256 in code) must scroll the table, never blow the
		// transcript column past its width.
		blocks.push(
			<div key={key++} className="md-tablewrap">
				<table className="md-table">
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
				</table>
			</div>,
		);
		continue;
		}

		// List kind is per-item so a model mixing - and 1. still renders
		// sanely; depth is indent/2.
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
