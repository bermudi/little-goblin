// Static markup — the doc-viewer surfaces' render contract.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";
import type { Artifact } from "../../src/agent/tools/artifact-schema.ts";
import { MessageParts } from "./ChatView.tsx";
import { ArtifactCard, DocViewerProvider } from "./docview.tsx";
import { Markdown } from "./markdown.tsx";
import { PathChip } from "./tools/bits.tsx";

const artifact: Artifact = {
	path: "/home/ws/attachments/abc-report.md",
	name: "report.md",
	title: "Quarterly report",
	mediaType: "text/markdown;charset=utf-8",
	size: 2048,
	source: { target: "workspace", path: "out/report.md" },
};

const toolPart = (name: string, output: unknown) =>
	({
		type: `tool-${name}`,
		toolCallId: `t-${name}`,
		state: "output-available",
		input: {},
		output,
	}) as unknown as UIMessage["parts"][number];

describe("ArtifactCard", () => {
	test("renders the title, name, media and size", () => {
		const html = renderToStaticMarkup(
			<DocViewerProvider token={null} conversationId="app/x">
				<ArtifactCard artifact={artifact} />
			</DocViewerProvider>,
		);
		expect(html).toContain("doccard");
		expect(html).toContain("Quarterly report");
		expect(html).toContain("report.md ·");
		expect(html).toContain("text/markdown");
		expect(html).toContain("2.0 KB");
	});

	test("falls back to the file name without a title", () => {
		const { title: _t, ...bare } = artifact;
		const html = renderToStaticMarkup(<ArtifactCard artifact={bare} />);
		expect(html).toContain("report.md");
		// No viewer — the card is inert, never a dead button.
		expect(html).toContain("disabled");
	});
});

describe("PathChip", () => {
	test("a plain span without a viewer, a button with one", () => {
		const span = renderToStaticMarkup(<PathChip path="wiki/index.md" />);
		expect(span).toContain("<span");
		expect(span).not.toContain("<button");
		const button = renderToStaticMarkup(
			<DocViewerProvider token={null} conversationId="app/x">
				<PathChip path="wiki/index.md" />
			</DocViewerProvider>,
		);
		expect(button).toContain("<button");
		expect(button).toContain("wiki/index.md");
	});
});

describe("MessageParts artifact hoisting", () => {
	test("a direct artifact call leaves a card after the fold", () => {
		const html = renderToStaticMarkup(
			<MessageParts
				parts={[
					toolPart("artifact", { artifact }),
					{ type: "text", text: "published" },
				]}
			/>,
		);
		expect(html).toContain("worked");
		expect(html).toContain("doccard");
		expect(html).toContain("Quarterly report");
	});

	test("a script's presentations hoist into cards — even on a failed script", () => {
		const scriptOut = {
			text: "Script failed after 1 tool call: late boom",
			calls: [{ tool: "artifact", args: "{}", ok: true, result: "{...}" }],
			error: "script",
			presentations: [{ call: "tc/1", artifact }],
		};
		const html = renderToStaticMarkup(
			<MessageParts parts={[toolPart("script", scriptOut)]} />,
		);
		expect(html).toContain("doccard");
		expect(html).toContain("Quarterly report");
	});

	test("a script without presentations leaves no card", () => {
		const html = renderToStaticMarkup(
			<MessageParts
				parts={[toolPart("script", { text: "ok", calls: [] })]}
			/>,
		);
		expect(html).not.toContain("doccard");
	});
});

describe("markdown relative links", () => {
	test("without onFileLink they stay literal; with one they become buttons", () => {
		const literal = renderToStaticMarkup(<Markdown text="see [other](other.md) now" />);
		expect(literal).toContain("[other](other.md)");
		expect(literal).not.toContain("md-filelink");
		const linked = renderToStaticMarkup(
			<Markdown text="see [other](other.md) and [ref](./sub/ref.md) now" onFileLink={() => {}} />,
		);
		expect(linked).not.toContain("[other](other.md)");
		expect((linked.match(/md-filelink/g) ?? []).length).toBe(2);
	});

	test("http links still win over the relative branch", () => {
		const html = renderToStaticMarkup(
			<Markdown text="[x](https://a.dev)" onFileLink={() => {}} />,
		);
		expect(html).toContain('href="https://a.dev"');
		expect(html).not.toContain("md-filelink");
	});

	test("non-http schemes and anchors stay literal even with a handler", () => {
		const html = renderToStaticMarkup(
			<Markdown
				text="[mail](mailto:a@b.c) [js](javascript:1) [anchor](#sec) [data](data:x)"
				onFileLink={() => {}}
			/>,
		);
		expect(html).not.toContain("md-filelink");
		expect(html).toContain("[mail](mailto:a@b.c)");
		expect(html).toContain("[anchor](#sec)");
	});
});
