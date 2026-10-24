import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown.tsx";

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
		expect(html).toContain("<th>a</th>");
		expect(html).toContain("<td>1</td>");
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
});
