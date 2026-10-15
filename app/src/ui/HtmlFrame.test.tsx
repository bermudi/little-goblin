// srcdoc() is the html leaf's whole security posture: the CSP meta
// leads, and navigations out of the frame are dead at the source.
// These tests pin the string-level guarantees; the click guard runs
// for real only in a browser.

import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { srcdoc } from "./HtmlFrame.tsx";

describe("srcdoc", () => {
	test("meta refresh is stripped, quoted or bare, any attribute order", () => {
		const html = `<meta http-equiv="refresh" content="0;url=https://evil.test">
<p>stay</p><meta content="0;url=https://evil.test" HTTP-EQUIV=refresh><p>still</p>`;
		const doc = srcdoc(html);
		// The guard's own source legitimately says "refresh" — the strip
		// contract is about the model html outside the scripts.
		const withoutGuard = doc.replace(/<script>[\s\S]*?<\/script>/g, "");
		expect(withoutGuard).not.toContain("refresh");
		expect(withoutGuard).toContain("<p>stay</p>");
		expect(withoutGuard).toContain("<p>still</p>");
	});

	test("the navigation guard and CSP lead the document, before model html", () => {
		const doc = srcdoc("<p>body</p>");
		const cspAt = doc.indexOf("Content-Security-Policy");
		const guardAt = doc.indexOf('addEventListener("click"');
		const bodyAt = doc.indexOf("<p>body</p>");
		expect(cspAt).toBeGreaterThan(-1);
		expect(guardAt).toBeGreaterThan(-1);
		expect(cspAt).toBeLessThan(bodyAt);
		expect(guardAt).toBeLessThan(bodyAt);
		// base-uri 'none' keeps a hostile <base> — static or inserted —
		// from redirecting the #fragment links the guard allows.
		const baseUriAt = doc.indexOf("base-uri 'none'");
		expect(baseUriAt).toBeGreaterThan(-1);
		expect(baseUriAt).toBeLessThan(bodyAt);
	});

	test("the guard cancels every anchor click and re-expresses fragments as location.hash", () => {
		// preventDefault is unconditional for a[href]; only a leading-#
		// href is then written to the document's own hash — no default
		// resolution through <base> or the embedding URL, ever.
		const doc = srcdoc("<p>x</p>");
		expect(doc).toContain("e.preventDefault()");
		expect(doc).toContain('charAt(0)==="#"');
		expect(doc).toContain("location.hash=h");
	});

	// Executed against a happy-dom document: a #fragment click must be
	// canceled AND set this document's hash — with or without a hostile
	// <base> in the head — while a non-fragment click is canceled and
	// leaves location untouched.
	test("anchor clicks set this document's hash, never navigate", () => {
		const doc = srcdoc("<p>x</p>");
		const guard = (doc.match(/<script>([\s\S]*?)<\/script>/g) ?? [])
			.map((s) => s.replace(/<\/?script>/g, ""))
			.find((js) => js.includes("MutationObserver"));
		if (guard === undefined) throw new Error("navigation guard missing");

		for (const withBase of [false, true]) {
			const dom = new Window({ url: "https://app.test/page" });
			if (withBase)
				dom.document.head.insertAdjacentHTML(
					"beforeend",
					'<base href="https://evil.test/escape/">',
				);
			dom.document.body.insertAdjacentHTML(
				"beforeend",
				'<a id="frag" href="#details">jump</a><a id="out" href="https://evil.test/x">out</a>',
			);
			new Function("document", "MutationObserver", "Element", "location", guard)(
				dom.document,
				dom.window.MutationObserver,
				dom.window.Element,
				dom.window.location,
			);
			const click = (el: InstanceType<typeof dom.window.Element>) => {
				const e = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
				el.dispatchEvent(e);
				return e;
			};

			const frag = click(dom.document.getElementById("frag")!);
			expect(frag.defaultPrevented).toBe(true);
			expect(dom.window.location.hash).toBe("#details");

			const out = click(dom.document.getElementById("out")!);
			expect(out.defaultPrevented).toBe(true);
			expect(dom.window.location.hash).toBe("#details");
			expect(dom.window.location.href).toBe("https://app.test/page#details");
		}
	});

	// Browsers honor metas inserted after load, so the strip-at-parse rule
	// alone only covers the static document — the live guard is the real
	// defense. Executed here against a happy-dom document: insert a
	// refresh meta post-load (the injection vector), watch it removed.
	test("the live guard removes a meta refresh inserted after load", async () => {
		const doc = srcdoc("<p>body</p>");
		const guard = (doc.match(/<script>([\s\S]*?)<\/script>/g) ?? [])
			.map((s) => s.replace(/<\/?script>/g, ""))
			.find((js) => js.includes("MutationObserver"));
		if (guard === undefined) throw new Error("navigation guard missing");

		const dom = new Window({ url: "https://app.test/frame" });
		new Function("document", "MutationObserver", guard)(dom.document, dom.window.MutationObserver);
		dom.document.head.insertAdjacentHTML(
			"beforeend",
			'<meta http-equiv="refresh" content="0;url=https://evil.test">',
		);
		// MutationObserver delivers as a microtask — flush before asserting.
		await new Promise((r) => setTimeout(r, 0));
		const refreshes = [...dom.document.head.querySelectorAll("meta")].filter(
			(m) => (m.getAttribute("http-equiv") ?? "").toLowerCase() === "refresh",
		);
		expect(refreshes).toEqual([]);
	});
});
