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
import { Markdown, inline } from "./markdown.tsx";
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
				parts={[toolPart("artifact", { artifact }), { type: "text", text: "published" }]}
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
		const html = renderToStaticMarkup(<MessageParts parts={[toolPart("script", scriptOut)]} />);
		expect(html).toContain("doccard");
		expect(html).toContain("Quarterly report");
	});

	test("a script without presentations leaves no card", () => {
		const html = renderToStaticMarkup(
			<MessageParts parts={[toolPart("script", { text: "ok", calls: [] })]} />,
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
		const html = renderToStaticMarkup(<Markdown text="[x](https://a.dev)" onFileLink={() => {}} />);
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

	test("a malformed percent escape is not a file open — the link stays literal", () => {
		const html = renderToStaticMarkup(<Markdown text="[bad](100%.md)" onFileLink={() => {}} />);
		// The destination cannot decode to a file: the link renders as
		// literal text — visible on the page, not a dead button.
		expect(html).not.toContain("md-filelink");
		expect(html).toContain("[bad](100%.md)");
	});

	test("a destination decodes exactly once; an escaped # stays in the name", () => {
		// Clicks don't fire in static markup — invoke the buttons'
		// real onClick closures straight off inline()'s elements so the
		// genuine decode path runs, no fakes.
		const got: string[] = [];
		const parts = inline(
			"[a](foo%2520.md) [b](foo%23bar.md) [c](x.md#frag) [d](..%2F..%2Fetc)",
			(p) => {
				got.push(p);
			},
		);
		for (const part of parts) {
			if (typeof part !== "object" || part === null) continue;
			const props = (part as { props?: { className?: string; onClick?: () => void } }).props;
			if (props?.className === "md-filelink") props.onClick?.();
		}
		// Decoded ONCE: foo%2520.md names a file literally called
		// "foo%20.md" — a second decode would silently open "foo .md".
		// %23 lands inside the name because the fragment split off
		// before decoding; a raw fragment never reaches the handler. An
		// encoded traversal decodes BEFORE the locator sees it, so it
		// climbs as a visible ".." the server can refuse.
		expect(got).toEqual(["foo%20.md", "foo#bar.md", "x.md", "../../etc"]);
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
	el.dispatchEvent(new dom.win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
const settle = () =>
	act(async () => {
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
		const written: string[] = [];
		Object.defineProperty(dom.win.navigator, "clipboard", {
			configurable: true,
			value: { writeText: async (text: string) => void written.push(text) },
		});
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
		await act(async () => {
			click(dom, dom.container.querySelector(".doc-copy")!);
		});
		expect(written).toEqual(["# Quarterly report\n\nbody"]);
		expect(dom.container.querySelector(".doc-copy")?.getAttribute("aria-label")).toBe("Copied");
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
		expect(dom.container.querySelector(".doc-copy")).toBeNull();
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
		expect(dom.container.querySelector(".doc-copy")).toBeNull();
	});

	// Destinations aren't paths until they're interpreted: percent
	// escapes decode, fragments split off, and a .. that climbs past the
	// workspace root is preserved and sent verbatim so the server can
	// refuse it (review findings).
	test("destinations decode, lose fragments, and climb loudly", async () => {
		const files = new Map<string, string>([
			["notes/my report.md", "# Report\n\nmade it"],
			["top.md", "# Top"],
		]);
		const indexText =
			"# Index\n\n[report](my%20report.md#summary) [up](../top.md) [out](../../other.md)";
		const requested: string[] = [];
		globalThis.fetch = (async (input) => {
			const u = new URL(String(input), "http://x");
			const p = u.searchParams.get("path") ?? "";
			requested.push(p);
			if (p.includes(".."))
				return new Response(JSON.stringify({ error: "refused: escapes the workspace" }), {
					status: 403,
					headers: { "content-type": "application/json" },
				});
			return p === "notes/index.md"
				? new Response(indexText, {
						status: 200,
						headers: { "content-type": "text/markdown" },
					})
				: new Response(files.get(p) ?? "", {
						status: 200,
						headers: { "content-type": "text/markdown" },
					});
		}) as typeof fetch;
		dom.root = createRoot(dom.container);
		await act(async () => {
			dom.root?.render(
				<DocViewerProvider token={null} conversationId="app/x">
					<PathChip path="notes/index.md" />
				</DocViewerProvider>,
			);
		});
		await act(async () => {
			click(dom, dom.container.querySelector("button.pathchip-link")!);
		});
		await settle();

		// The escaped destination names the real file; the fragment is
		// not part of the path.
		await act(async () => {
			click(dom, dom.container.querySelector(".md-filelink")!);
		});
		await settle();
		expect(requested.at(-1)).toBe("notes/my report.md");
		expect(dom.container.querySelector(".doc-head h3")?.textContent).toBe("my report.md");
		await act(async () => {
			click(dom, dom.container.querySelector(".doc-back")!);
		});

		// A legal climb stays in the workspace: ../top.md from notes/.
		await act(async () => {
			click(dom, dom.container.querySelectorAll(".md-filelink")[1]!);
		});
		await settle();
		expect(requested.at(-1)).toBe("top.md");
		expect(dom.container.querySelector(".doc-head h3")?.textContent).toBe("top.md");
		await act(async () => {
			click(dom, dom.container.querySelector(".doc-back")!);
		});

		// The escape past the root rides the request verbatim — the
		// server's refusal is the only sane answer.
		await act(async () => {
			click(dom, dom.container.querySelectorAll(".md-filelink")[2]!);
		});
		await settle();
		expect(requested.at(-1)).toBe("../other.md");
		expect(dom.container.querySelector(".doc-err")?.textContent).toContain("escapes the workspace");
	});

	test("a pdf shows the download affordance — never a sandboxed frame", async () => {
		globalThis.fetch = (async (_input: RequestInfo | URL) =>
			new Response("%PDF-1.4 pretend bytes", {
				status: 200,
				headers: { "content-type": "application/pdf" },
			})) as typeof fetch;
		dom.root = createRoot(dom.container);
		await act(async () => {
			dom.root?.render(
				<DocViewerProvider token={null} conversationId="app/x">
					<PathChip path="doc.pdf" />
				</DocViewerProvider>,
			);
		});
		await act(async () => {
			click(dom, dom.container.querySelector("button.pathchip-link")!);
		});
		await settle();
		expect(dom.container.querySelector(".doc-frame")).toBeNull();
		expect(dom.container.querySelector(".doc-download")?.textContent).toContain("doc.pdf");
		expect(dom.container.querySelector(".doc-copy")).toBeNull();
	});

	for (const [path, type, selector] of [
		["pic.png", "image/png", "img.doc-media"],
		["sound.ogg", "audio/ogg", "audio.doc-media"],
		["movie.webm", "video/webm", "video.doc-media"],
		["data.bin", "application/octet-stream", ".doc-download"],
	] as const) {
		test(`a ${type} doc shows no copy button`, async () => {
			globalThis.fetch = (async (_input: RequestInfo | URL) =>
				new Response(new Uint8Array([137, 80, 78, 71]), {
					status: 200,
					headers: { "content-type": type },
				})) as typeof fetch;
			dom.root = createRoot(dom.container);
			await act(async () => {
				dom.root?.render(
					<DocViewerProvider token={null} conversationId="app/x">
						<PathChip path={path} />
					</DocViewerProvider>,
				);
			});
			await act(async () => {
				click(dom, dom.container.querySelector("button.pathchip-link")!);
			});
			await settle();
			expect(dom.container.querySelector(selector)).not.toBeNull();
			expect(dom.container.querySelector(".doc-copy")).toBeNull();
		});
	}

	// Copy hands over the decoded source — markdown and html as written,
	// not as rendered — and shows the shared copied state.
	for (const [path, type, body] of [
		["notes.md", "text/markdown", "# Notes\n\n**raw** source"],
		["page.html", "text/html", "<h1>Page</h1><script>1</script>"],
		["run.log", "text/plain", "line one\nline two\nλ 中文 🙂"],
		["empty.txt", "text/plain", ""],
	] as const) {
		test(`${path} copies its raw text`, async () => {
			const written: string[] = [];
			Object.defineProperty(dom.win.navigator, "clipboard", {
				configurable: true,
				value: { writeText: async (t: string) => void written.push(t) },
			});
			globalThis.fetch = (async (_input: RequestInfo | URL) =>
				new Response(body, { status: 200, headers: { "content-type": type } })) as typeof fetch;
			dom.root = createRoot(dom.container);
			await act(async () => {
				dom.root?.render(
					<DocViewerProvider token={null} conversationId="app/x">
						<PathChip path={path} />
					</DocViewerProvider>,
				);
			});
			await act(async () => {
				click(dom, dom.container.querySelector("button.pathchip-link")!);
			});
			await settle();
			const btn = dom.container.querySelector(".doc-head .doc-copy");
			expect(btn?.textContent).toBe("copy");
			await act(async () => {
				click(dom, btn!);
			});
			await settle();
			expect(written).toEqual([body]);
			expect(dom.container.querySelector(".doc-copy")?.textContent).toBe("✓");
			expect(dom.container.querySelector(".doc-copy")?.getAttribute("aria-label")).toBe("Copied");
		});
	}

	for (const verdict of ["copied", "failed", "pending"] as const) {
		test(`${verdict} feedback belongs to the document that was copied`, async () => {
			const index = "# Index\n\n[other](other.md)";
			const written: string[] = [];
			let finishWrite: (() => void) | undefined;
			Object.defineProperty(dom.win.navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async (text: string) => {
						written.push(text);
						if (written.length !== 1) return;
						if (verdict === "failed") throw new Error("clipboard denied");
						if (verdict === "pending")
							await new Promise<void>((resolve) => {
								finishWrite = resolve;
							});
					},
				},
			});
			let finishFetch: ((response: Response) => void) | undefined;
			globalThis.fetch = (async (input) => {
				const path = new URL(String(input), "http://x").searchParams.get("path");
				return path === "index.md"
					? new Response(index, { headers: { "content-type": "text/markdown" } })
					: new Promise<Response>((resolve) => {
							finishFetch = resolve;
						});
			}) as typeof fetch;
			dom.root = createRoot(dom.container);
			await act(async () => {
				dom.root?.render(
					<DocViewerProvider token={null} conversationId="app/x">
						<PathChip path="index.md" />
					</DocViewerProvider>,
				);
			});
			await act(async () => {
				click(dom, dom.container.querySelector("button.pathchip-link")!);
			});
			await settle();
			await act(async () => {
				click(dom, dom.container.querySelector(".doc-copy")!);
			});
			expect(dom.container.querySelector(".doc-copy")?.getAttribute("aria-label")).toBe(
				verdict === "copied" ? "Copied" : verdict === "failed" ? "Copy failed" : "Copy",
			);
			await act(async () => {
				click(dom, dom.container.querySelector(".md-filelink")!);
			});
			expect(dom.container.querySelector(".doc-body")?.textContent).toBe("loading…");
			expect(dom.container.querySelector(".doc-copy")).toBeNull();
			await act(async () => {
				finishFetch!(new Response("Other text", { headers: { "content-type": "text/plain" } }));
			});
			await settle();
			expect(dom.container.querySelector(".doc-copy")?.getAttribute("aria-label")).toBe("Copy");
			if (verdict === "pending") {
				await act(async () => {
					finishWrite!();
				});
				expect(dom.container.querySelector(".doc-copy")?.getAttribute("aria-label")).toBe("Copy");
			}
			await act(async () => {
				click(dom, dom.container.querySelector(".doc-copy")!);
			});
			expect(written).toEqual([index, "Other text"]);
			await act(async () => {
				click(dom, dom.container.querySelector(".doc-back")!);
			});
			await settle();
			expect(dom.container.querySelector(".doc-copy")?.getAttribute("aria-label")).toBe("Copy");
			await act(async () => {
				click(dom, dom.container.querySelector(".doc-copy")!);
			});
			expect(written).toEqual([index, "Other text", index]);
		});
	}

	test("a rejected copy shows failure and can be retried", async () => {
		let attempts = 0;
		Object.defineProperty(dom.win.navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async () => {
					if (++attempts === 1) throw new Error("clipboard denied");
				},
			},
		});
		globalThis.fetch = (async (_input: RequestInfo | URL) =>
			new Response("retry me", { headers: { "content-type": "text/plain" } })) as typeof fetch;
		dom.root = createRoot(dom.container);
		await act(async () => {
			dom.root?.render(
				<DocViewerProvider token={null} conversationId="app/x">
					<PathChip path="retry.txt" />
				</DocViewerProvider>,
			);
		});
		await act(async () => {
			click(dom, dom.container.querySelector("button.pathchip-link")!);
		});
		await settle();
		await act(async () => {
			click(dom, dom.container.querySelector(".doc-copy")!);
		});
		expect(dom.container.querySelector(".doc-copy")?.textContent).toBe("copy failed");
		expect(dom.container.querySelector(".doc-copy")?.getAttribute("aria-label")).toBe("Copy failed");
		await act(async () => {
			click(dom, dom.container.querySelector(".doc-copy")!);
		});
		expect(attempts).toBe(2);
		expect(dom.container.querySelector(".doc-copy")?.getAttribute("aria-label")).toBe("Copied");
	});
});
