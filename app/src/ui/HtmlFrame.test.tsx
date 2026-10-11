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
	});

	test("the guard only exempts #fragment hrefs", () => {
		// charAt(0)!=="#" is the guard's single exemption branch —
		// in-document anchors navigate, nothing else does.
		expect(srcdoc("<p>x</p>")).toContain('charAt(0)!=="#"');
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
