// Static markup — the doc-viewer surfaces' render contract.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
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

// Mounted rig — one happy-dom window per test, fetch faked at
// globalThis. The real journey: chip click → route fetch → modal;
// the static-markup tests above can't see any of that.
function mountDom() {
	const dom = {
		win: undefined as unknown as Window,
		container: undefined as unknown as HTMLElement,
		root: null as Root | null,
		realFetch: globalThis.fetch,
	};
	const installed: string[] = [];
	const install = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	beforeEach(() => {
		dom.realFetch = globalThis.fetch;
		dom.win = new Window();
		const div = dom.win.document.createElement("div");
		dom.win.document.body.appendChild(div);
		dom.container = div as unknown as HTMLElement;
		installed.length = 0;
		install("window", dom.win);
		install("document", dom.win.document);
		install("navigator", dom.win.navigator);
		install("localStorage", dom.win.localStorage);
		install("Event", dom.win.Event);
		install("MouseEvent", dom.win.MouseEvent);
		install("CustomEvent", dom.win.CustomEvent);
		install("getComputedStyle", dom.win.getComputedStyle);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	});

	afterEach(async () => {
		if (dom.root !== null) {
			await act(async () => {
				dom.root?.unmount();
			});
			dom.root = null;
		}
		await dom.win.happyDOM.close();
		globalThis.fetch = dom.realFetch;
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		for (const name of installed) Reflect.deleteProperty(globalThis, name);
		installed.length = 0;
	});
	return dom;
}

const click = (dom: { win: Window }, el: Element) =>
	el.dispatchEvent(new dom.win.MouseEvent("click", { bubbles: true }) as unknown as Event);
const settle = () => act(async () => {
	await new Promise((r) => setTimeout(r, 20));
});

describe("doc viewer journey (happy-dom)", () => {
	const dom = mountDom();

	test("chip click fetches the live file; markdown links navigate; back walks the stack", async () => {
		const files = new Map([
			["wiki/index.md", "# Index\n\nSee [other](other.md) too."],
			["wiki/other.md", "# Other\n\nmade it"],
		]);
		const fetches: string[] = [];
		globalThis.fetch = (async (input) => {
			const url = String(input);
			fetches.push(url);
			const u = new URL(url, "http://x");
			const body = files.get(u.searchParams.get("path") ?? "");
			return body === undefined
				? new Response(JSON.stringify({ error: "source not found" }), {
						status: 404,
						headers: { "content-type": "application/json" },
					})
				: new Response(body, {
						status: 200,
						headers: { "content-type": "text/markdown" },
					});
		}) as typeof fetch;
		dom.root = createRoot(dom.container);
		await act(async () => {
			dom.root?.render(
				<DocViewerProvider token={null} conversationId="app/x">
					<PathChip path="wiki/index.md" />
				</DocViewerProvider>,
			);
		});
		const chip = dom.container.querySelector("button.pathchip-link");
		expect(chip).not.toBeNull();
		await act(async () => {
			click(dom, chip!);
		});
		await settle();
		expect(fetches[0]).toContain("/api/app/conversations/x/file?path=wiki%2Findex.md");
		expect(dom.container.querySelector(".doc-body")?.textContent).toContain("Index");

		const link = dom.container.querySelector(".md-filelink");
		expect(link).not.toBeNull();
		await act(async () => {
			click(dom, link!);
		});
		await settle();
		expect(fetches.at(-1)).toContain("path=wiki%2Fother.md");
		expect(dom.container.querySelector(".doc-head h3")?.textContent).toBe("other.md");

		const back = dom.container.querySelector(".doc-back");
		expect(back).not.toBeNull();
		await act(async () => {
			click(dom, back!);
		});
		expect(dom.container.querySelector(".doc-head h3")?.textContent).toBe("index.md");
	});

	test("an artifact card opens its published snapshot through the attachment route", async () => {
		const seen: string[] = [];
		globalThis.fetch = (async (input) => {
			const url = String(input);
			seen.push(url);
			return new Response("# Quarterly report\n\nbody", {
				status: 200,
				headers: { "content-type": "application/octet-stream" },
			});
		}) as typeof fetch;
		dom.root = createRoot(dom.container);
		await act(async () => {
			dom.root?.render(
				<DocViewerProvider token={null} conversationId="app/x">
					<ArtifactCard artifact={artifact} />
				</DocViewerProvider>,
			);
		});
		const card = dom.container.querySelector("button.doccard");
		expect(card).not.toBeNull();
		await act(async () => {
			click(dom, card!);
		});
		await settle();
		// The stored name (basename of the attachment path) is what the
		// route takes; the declared mediaType drives the render kind.
		expect(seen[0]).toContain("/api/app/attachments/file?name=abc-report.md");
		expect(dom.container.querySelector(".doc-head h3")?.textContent).toBe("Quarterly report");
		expect(dom.container.querySelector(".doc-md")?.textContent).toContain("body");
	});

	test("a refused read surfaces the server error, never silent nothing", async () => {
		globalThis.fetch = (async (_input: RequestInfo | URL) =>
			new Response(JSON.stringify({ error: "refused: auth.jsonl is never served" }), {
				status: 403,
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		dom.root = createRoot(dom.container);
		await act(async () => {
			dom.root?.render(
				<DocViewerProvider token={null} conversationId="app/x">
					<PathChip path="auth.jsonl" />
				</DocViewerProvider>,
			);
		});
		await act(async () => {
			click(dom, dom.container.querySelector("button.pathchip-link")!);
		});
		await settle();
		expect(dom.container.querySelector(".doc-err")?.textContent).toContain(
			"auth.jsonl is never served",
		);
	});

	test("an oversized markdown downloads instead of rendering", async () => {
		globalThis.fetch = (async (_input: RequestInfo | URL) =>
			new Response("# big\n\n" + "x".repeat(4 * 1024 * 1024), {
				status: 200,
				headers: { "content-type": "text/markdown" },
			})) as typeof fetch;
		dom.root = createRoot(dom.container);
		await act(async () => {
			dom.root?.render(
				<DocViewerProvider token={null} conversationId="app/x">
					<PathChip path="big.md" />
				</DocViewerProvider>,
			);
		});
		await act(async () => {
			click(dom, dom.container.querySelector("button.pathchip-link")!);
		});
		await settle();
		// The decode cap demotes markdown like text — the parser is the
		// freeze, not just the string decode.
		expect(dom.container.querySelector(".doc-md")).toBeNull();
		expect(dom.container.querySelector(".doc-download")?.textContent).toContain("big.md");
	});
});
