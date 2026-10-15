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

	test("a pipe table renders header and rows", () => {
		const html = renderToStaticMarkup(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |"} />);
		expect(html).toContain("<table");
		expect(html).toContain("<th>a</th>");
		expect(html).toContain("<td>1</td>");
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

	test("a note fence cut off at EOF renders as code — no card until the closer arrives", () => {
		const partial = "```note\nappend this body";
		const open = renderToStaticMarkup(<Markdown text={partial} />);
		expect(open).not.toContain("note-card");
		expect(open).toContain('class="codeblock"');
		expect(open).toContain("append this body");
		const closed = renderToStaticMarkup(<Markdown text={`${partial}\n\`\`\``} />);
		expect(closed).toContain("note-card");
		expect(closed).toContain("append this body");
	});

	test("a note fence with a title cut off at EOF renders as code — no card", () => {
		const html = renderToStaticMarkup(<Markdown text={'```note title="Draft"\nsome body'} />);
		expect(html).not.toContain("note-card");
		expect(html).toContain('class="codeblock"');
	});

	test("a shorter fence inside a four-backtick note fence never closes it", () => {
		const html = renderToStaticMarkup(
			<Markdown text={"````note\nkeep this\n```\ninner triple\n"} />,
		);
		expect(html).not.toContain("note-card");
		expect(html).toContain('class="codeblock"');
	});

	test("a completed four-backtick note fence holds triple-backtick code intact", () => {
		const html = renderToStaticMarkup(
			<Markdown text={"````note\nkeep this\n```\ninner code\n```\ntail of note\n````"} />,
		);
		expect(html).toContain("note-card");
		expect(html).toContain("keep this");
		expect(html).toContain("inner code");
		expect(html).toContain("tail of note");
	});
});
