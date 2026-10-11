// srcdoc() is the html leaf's whole security posture: the CSP meta
// leads, and navigations out of the frame are dead at the source.
// These tests pin the string-level guarantees; the click guard runs
// for real only in a browser.

import { describe, expect, test } from "bun:test";
import { srcdoc } from "./HtmlFrame.tsx";

describe("srcdoc", () => {
	test("meta refresh is stripped, quoted or bare, any attribute order", () => {
		const html = `<meta http-equiv="refresh" content="0;url=https://evil.test">
<p>stay</p><meta content="0;url=https://evil.test" HTTP-EQUIV=refresh><p>still</p>`;
		const doc = srcdoc(html);
		expect(doc).not.toContain("refresh");
		expect(doc).toContain("<p>stay</p>");
		expect(doc).toContain("<p>still</p>");
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
});
