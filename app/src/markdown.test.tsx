import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, shortColumns } from "./markdown.tsx";

// Static markup only — guards the render contract (which elements a
// block shape produces), not React behavior.

describe("Markdown", () => {
	test("paragraphs split on blank lines and soft-wrapped lines join", () => {
		const html = renderToStaticMarkup(<Markdown text={"first para\nsecond line\n\nsecond para"} />);
		expect(html.match(/<p>/g)?.length).toBe(2);
		expect(html).toContain("first para\nsecond line");
	});

	test("headings, hr, and blockquotes render as their own blocks", () => {
		const html = renderToStaticMarkup(
			<Markdown text={"# Title\n\n> a quote\n> still quoted\n\n---\n\ntail"} />,
		);
		expect(html).toContain('class="md-h"');
		expect(html).toContain("Title");
		expect(html).toContain("<blockquote");
		expect(html).toContain("a quote");
		expect(html).toContain('class="md-hr"');
	});

	test("bullets, ordered items, and checkboxes nest by indent", () => {
		const html = renderToStaticMarkup(
			<Markdown text={"- one\n  - nested\n- [x] done\n- [ ] todo\n\n1. first\n2. second"} />,
		);
		expect(html).toContain("<ul");
		expect(html).toContain("<ol");
		expect(html).toContain("☑");
		expect(html).toContain("☐");
		expect(html).toContain("nested");
	});

	test("a pipe table renders header and rows inside the scroll wrapper", () => {
		const html = renderToStaticMarkup(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |"} />);
		expect(html).toContain('class="md-tablewrap"');
		expect(html).toContain("<table");
		expect(html).toContain(">a</th>");
		expect(html).toContain(">1</td>");
	});

	// A pasted ╔═╗ table is alignment-dependent art — the mid-rule
	// names the first band the header, and a cell the drawing wrapped
	// across physical lines rejoins. An unclosed tail (no bottom
	// border) still parses.
	test("a box-drawn table renders as a real table, wrapped cells rejoined", () => {
		const html = renderToStaticMarkup(
			<Markdown
				text={[
					" ┌────────┬───────┐",
					" │ Name   │ Note  │",
					" ├────────┼───────┤",
					" │ a      │ one   │",
					" │        │ two   │",
					" ├────────┼───────┤",
					" │ b      │ three │",
				].join("\n")}
			/>,
		);
		expect(html).toContain('class="md-tablewrap"');
		expect(html).toContain(">Name</th>");
		expect(html).toContain(">Note</th>");
		expect(html).toContain(">one two</td>");
		expect(html).toContain(">three</td>");
	});

	test("a box table without a mid rule renders rows without a header", () => {
		const html = renderToStaticMarkup(
			<Markdown text={"┌───┬───┐\n│ a │ b │\n│ 1 │ 2 │\n└───┴───┘"} />,
		);
		expect(html).toContain('class="md-tablewrap"');
		expect(html).not.toContain("<th");
		expect(html).toContain(">a</td>");
		expect(html).toContain(">2</td>");
	});

	test("box art that is not a table keeps its fixed-width shape in a fence", () => {
		const html = renderToStaticMarkup(<Markdown text={"tree\n├── a.ts\n└── b.ts"} />);
		expect(html).toContain("codeblock");
		expect(html).toContain("├── a.ts");
		expect(html).not.toContain("<table");
	});

	test("a lone box-char line stays prose", () => {
		const html = renderToStaticMarkup(<Markdown text={"a ── b\nplain line"} />);
		expect(html).toContain("<p>");
		expect(html).not.toContain("codeblock");
		expect(html).not.toContain("<table");
	});

	// A status bar's top+bottom borders arrive as stroke-only lines —
	// verbatim screen capture the transcript must not echo back as
	// paragraphs of dash glyphs.
	test("a pure box-stroke line is a drawn rule, its band collapses to one", () => {
		const rule = "─".repeat(60);
		const html = renderToStaticMarkup(
			<Markdown text={`Error: Retry failed after 5 attempts\n\n${rule}\n\n${rule}\nstatus line`} />,
		);
		expect(html.match(/class="md-hr"/g)?.length).toBe(1);
		expect(html).toContain("status line");
		expect(html).toContain("Retry failed");
		expect(html).not.toContain(rule);
	});

	test("a drawn rule inside a box run still keeps the table shape", () => {
		const html = renderToStaticMarkup(
			<Markdown text={"┌───┬───┐\n│ a │ b │\n├───┼───┤\n│ 1 │ 2 │\n└───┴───┘"} />,
		);
		expect(html).toContain('class="md-tablewrap"');
		expect(html).toContain(">2</td>");
	});

	// Delegation and program notices open with a machinery tag line —
	// machine speech that must read as an envelope, not transcript prose.
	test("a machinery tag line renders fenced, following prose stays text", () => {
		const html = renderToStaticMarkup(
			<Markdown
				text={
					'[delegation: #4 whistle-digest-check · done]\n\n<event source="delegation">\n# Report\n\nbody text'
				}
			/>,
		);
		expect(html).toContain('class="codeblock-lang">status');
		expect(html).toContain("[delegation: #4 whistle-digest-check · done]");
		expect(html).not.toContain("<p>[delegation:");
		expect(html).toContain('class="md-h"');
		expect(html).toContain("body text");
	});

	test("a program tag fences alone and its charter paragraph continues", () => {
		const html = renderToStaticMarkup(
			<Markdown text={"[program: digest · trigger: cron 0 9 * * *]\nRun the digest."} />,
		);
		expect(html).toContain('class="codeblock-lang">status');
		expect(html).toContain("Run the digest.");
		expect(html).toContain("<p>Run the digest.</p>");
	});

	test("a bracket line that is not machinery stays a paragraph", () => {
		const html = renderToStaticMarkup(<Markdown text={"[see this](https://example.com) link"} />);
		expect(html).not.toContain("codeblock");
		expect(html).toContain("<p>");
	});

	test("fenced code highlights a known language and labels it", () => {
		const html = renderToStaticMarkup(<Markdown text={"```python\ndef f():\n    return 1\n```"} />);
		expect(html).toContain('class="codeblock-lang">python');
		expect(html).toContain("hljs-keyword");
	});

	test("an unknown fence tag stays plain, code intact", () => {
		const html = renderToStaticMarkup(<Markdown text={"```notalang\n<raw> & stuff\n```"} />);
		expect(html).toContain('class="codeblock-lang">notalang');
		expect(html).not.toContain("hljs-keyword");
		expect(html).toContain("&lt;raw&gt;");
	});

	test("strikethrough and markdown-in-cells render inline", () => {
		const html = renderToStaticMarkup(<Markdown text={"~~gone~~ and **bold**"} />);
		expect(html).toContain("<s>gone</s>");
		expect(html).toContain("<strong>bold</strong>");
	});

	// A note fence mid-stream is a prefix — appending it now would
	// save content the chunks after it silently drop. Once the reply
	// settles (or lands from history) the prefix is all there is, so
	// the affordance shows even without the closing fence.
	test("an unclosed note fence withholds the affordance only while streaming", () => {
		const streaming = renderToStaticMarkup(<Markdown text={"```note\npartial body"} streaming />);
		expect(streaming).toContain("note-card");
		expect(streaming).toContain("partial body");
		expect(streaming).not.toContain("note-card-append");
		// Settled — the default for callers with no stream. The card's
		// truncated body is final, so the affordance appears anyway.
		const settled = renderToStaticMarkup(<Markdown text={"```note\npartial body"} />);
		expect(settled).toContain("note-card-append");
		// A closed fence shows it even mid-stream.
		const closed = renderToStaticMarkup(<Markdown text={"```note\nfull body\n```"} streaming />);
		expect(closed).toContain("note-card-append");
	});
	test("an unfinished titled note hides append until its message settles", () => {
		const text = '```note title="Draft"\nsome body';
		const live = renderToStaticMarkup(<Markdown text={text} streaming />);
		expect(live).toContain("note-card");
		expect(live).not.toContain("note-card-append");
		expect(renderToStaticMarkup(<Markdown text={text} />)).toContain("note-card-append");
	});

	test("a shorter fence inside a four-backtick note never enables append mid-stream", () => {
		const text = "````note\nkeep this\n```\ninner triple\n";
		const live = renderToStaticMarkup(<Markdown text={text} streaming />);
		expect(live).toContain("note-card");
		expect(live).not.toContain("note-card-append");
		const closed = renderToStaticMarkup(<Markdown text={`${text}\n\`\`\`\``} streaming />);
		expect(closed).toContain("note-card-append");
		expect(closed).toContain("inner triple");
	});

	test("a completed four-backtick note holds triple-backtick code intact", () => {
		const html = renderToStaticMarkup(
			<Markdown text={"````note\nkeep this\n```\ninner code\n```\ntail of note\n````"} />,
		);
		expect(html).toContain("note-card");
		expect(html).toContain("keep this");
		expect(html).toContain("inner code");
		expect(html).toContain("tail of note");
	});

	test("clipFences caps a fence over 20 lines with a show-all tail", () => {
		const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
		const html = renderToStaticMarkup(<Markdown text={`\`\`\`text\n${body}\n\`\`\``} clipFences />);
		expect(html).toContain('class="clip"');
		expect(html).toContain("max-height");
		expect(html).toContain("codeblock-fade");
		expect(html).toContain("show all 30 lines");
		// The clip is visual — the pre still carries every line.
		expect(html).toContain("line 30");
	});

	test("clipFences leaves fences at the threshold whole", () => {
		const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		const html = renderToStaticMarkup(<Markdown text={`\`\`\`\n${body}\n\`\`\``} clipFences />);
		expect(html).not.toContain("codeblock-more");
		expect(html).not.toContain('class="clip"');
	});

	test("a long fence stays whole without clipFences — model output is untouched", () => {
		const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
		const html = renderToStaticMarkup(<Markdown text={`\`\`\`text\n${body}\n\`\`\``} />);
		expect(html).not.toContain("codeblock-more");
		expect(html).not.toContain('class="clip"');
	});

	// Column width policy is decided from content, never position: a
	// column is nowrap only if every cell (header included) is short.
	test("shortColumns classifies columns by content, not position", () => {
		const prose = "Latest (Aug 2026). Same base as 5.2, post-training boost.";
		expect(shortColumns(["Model", "Price", "Notes"], [["GLM-5.3", "$1.40 / $4.40", prose]])).toEqual([
			true,
			true,
			false,
		]);
		// Prose first: the short columns after it stay short.
		expect(shortColumns(["Notes", "Id"], [[prose, "a1"]])).toEqual([false, true]);
		// One long cell anywhere makes the whole column wrap.
		expect(shortColumns(null, [["a"], ["x".repeat(60)]])).toEqual([false]);
		// Link targets and markers don't count toward the width.
		expect(shortColumns(null, [["[docs](https://example.com/a/very/long/path/that/goes/on)"]])).toEqual([true]);
		// Ragged rows: a missing cell is empty, not long.
		expect(shortColumns(["a", "b"], [["1"]])).toEqual([true, true]);
	});

	test("a table marks short columns nowrap and leaves prose columns wrapping", () => {
		const html = renderToStaticMarkup(
			<Markdown text={"| id | note |\n|---|---|\n| a1 | " + "word ".repeat(12) + " |"} />,
		);
		expect(html).toContain('<th class="md-nw">id</th>');
		expect(html).toContain('<td class="md-nw">a1</td>');
		expect(html).toMatch(/<th>note<\/th>/);
	});
});
