import { describe, expect, test } from "bun:test";
import { chunkWindows } from "./delivery-text.ts";
import { renderTelegramHtml } from "./tg-html.ts";

describe("renderTelegramHtml", () => {
	test("inline marks render to entities", () => {
		expect(renderTelegramHtml("**bold** and *ital* and `code` and ~~gone~~")).toBe(
			"<b>bold</b> and <i>ital</i> and <code>code</code> and <s>gone</s>",
		);
	});

	test("html chars in text escape; link hrefs escape for attributes", () => {
		expect(renderTelegramHtml("a < b && [x](https://e.test/?a=1&b=2)")).toBe(
			'a &lt; b &amp;&amp; <a href="https://e.test/?a=1&amp;b=2">x</a>',
		);
	});

	test("headings and blockquotes render", () => {
		expect(renderTelegramHtml("## Title\n> quoted **b**\n> more\ntail")).toBe(
			"<b>Title</b>\n<blockquote>quoted <b>b</b>\nmore</blockquote>\ntail",
		);
	});

	test("fenced code escapes contents and keeps the language", () => {
		expect(renderTelegramHtml("before\n```ts\nif (a < b) {}\n```\nafter")).toBe(
			'before\n<pre><code class="language-ts">if (a &lt; b) {}</code></pre>\nafter',
		);
	});

	test("a fence cut by a window boundary stays code on both sides", () => {
		// chunkWindows closes the fence at the first window's end and
		// reopens it with the same info string on the next — each window
		// renders independently, no state between them.
		const windows = chunkWindows("text\n```python\nx = 1\n" + "y".repeat(3900) + "\n```\ndone");
		expect(windows.length).toBe(2);
		// Window 0: 21 leading chars + 3779 y's, fence closed by chunkWindows.
		expect(renderTelegramHtml(windows[0]!)).toBe(
			`text\n<pre><code class="language-python">x = 1\n${"y".repeat(3779)}</code></pre>`,
		);
		// Window 1: reopened fence, remaining 121 y's, the real close, tail.
		expect(renderTelegramHtml(windows[1]!)).toBe(
			`<pre><code class="language-python">${"y".repeat(121)}</code></pre>\ndone`,
		);
	});

	test("unmatched markers stay literal — never invented entities", () => {
		expect(renderTelegramHtml("snake_case_var and **open")).toBe(
			"snake_case_var and **open",
		);
	});

	test("nested marks inside bold render", () => {
		expect(renderTelegramHtml("**bold `code` end**")).toBe(
			"<b>bold <code>code</code> end</b>",
		);
	});
});
