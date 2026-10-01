import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";
import { MessageParts } from "./ChatView.tsx";

// Static markup only — these guard the transcript's render contract
// (links become anchors, tool runs fold), not React behavior.

const toolPart = {
	type: "tool-lookup",
	toolCallId: "t1",
	state: "output-available",
	input: { q: "x" },
	output: { ok: true },
} as unknown as UIMessage["parts"][number];

describe("MessageParts", () => {
	test("a run of tool parts collapses into the Worked fold", () => {
		const html = renderToStaticMarkup(
			<MessageParts parts={[toolPart, { type: "text", text: "the answer" }]} />,
		);
		expect(html).toContain('class="worked"');
		expect(html).toContain("Worked");
		expect(html).toContain("lookup");
		expect(html).toContain("the answer");
	});

	test("markdown links render as anchors, not literal syntax", () => {
		const html = renderToStaticMarkup(
			<MessageParts
				parts={[{ type: "text", text: "see [example.com](https://example.com) now" }]}
			/>,
		);
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain(">example.com</a>");
		expect(html).not.toContain("[example.com]");
	});

	test("bare URLs and code spans still render", () => {
		const html = renderToStaticMarkup(
			<MessageParts parts={[{ type: "text", text: "visit https://a.dev or run `ls`" }]} />,
		);
		expect(html).toContain('href="https://a.dev"');
		expect(html).toContain("<code>ls</code>");
	});
});
