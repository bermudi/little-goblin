// The html leaf — model-written documents in <iframe sandbox=
// "allow-scripts" srcdoc> (design/app.md → Intelligent UI, escape
// hatch). No allow-same-origin ever: the opaque origin cannot read the
// app's storage, DOM, or token. Height comes from an injected
// ResizeObserver via postMessage — this frame's window only, clamped.
// CSP governs fetches, never navigations: a frame navigated away sheds
// the injected CSP but keeps allow-scripts, handing a remote page
// network egress and rendering inside trusted chrome. Declarative and
// click-driven navigations are neutralized at the source (meta refresh
// stripped in srcdoc(), every anchor click canceled — a leading "#" is
// re-expressed as this document's own location.hash instead); a direct
// location assignment from script remains the accepted residual.

import { useEffect, useMemo, useRef, useState } from "react";
import type { UiLeaf } from "../../../src/agent/tools/ui-schema.ts";

// base-uri 'none' pins resolution as belt: the click guard sets
// location.hash verbatim without resolving hrefs, but no static or
// script-inserted <base href> should ever be usable anyway.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'">`;

// documentElement.scrollHeight can't drop below the frame's own
// viewport — a one-way ratchet — so measure body bounds instead
// (html,body are height:auto below). <body> may not exist when this
// runs; observe after DOMContentLoaded.
const RESIZE = `<script>addEventListener("DOMContentLoaded",function(){new ResizeObserver(function(){parent.postMessage({goblinUiHeight:Math.ceil(document.body.getBoundingClientRect().height)},"*")}).observe(document.body)})</script>`;

// In-page anchors still work, but no anchor click ever navigates:
// every a[href] click is canceled, and a leading-# href is written to
// this document's own location.hash — same-document, resolved against
// neither <base> nor the inherited parent URL. Capture phase — the
// document's own handlers must not get to run the default first.
// Declarative navigations are neutralized at the source too: the static
// meta refresh is stripped in srcdoc(), and — because browsers honor
// metas inserted after load — the guard also watches the live document
// and removes any refresh meta that script inserts (or retrofits onto
// an existing tag). Drags on anchors are dead. What remains is the
// documented residual: a direct `location` assignment from script,
// un-interceptable from inside the document (design/app.md →
// Intelligent UI → Escape hatch: html).
const NAVIGATION_GUARD = `<script>
document.addEventListener("click",function(e){var t=e.target;if(!(t instanceof Element))return;var a=t.closest("a[href]");if(a){e.preventDefault();var h=a.getAttribute("href")||"";if(h.charAt(0)==="#")location.hash=h}},true);
document.addEventListener("dragstart",function(e){var t=e.target;if(t instanceof Element&&t.closest("a[href]"))e.preventDefault()},true);
function isRefresh(m){return m.tagName==="META"&&(m.getAttribute("http-equiv")||"").toLowerCase()==="refresh"}
new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];if(m.type==="attributes"){if(isRefresh(m.target))m.target.remove();continue}for(var j=0;j<m.addedNodes.length;j++){var n=m.addedNodes[j];if(n.nodeType!==1)continue;if(isRefresh(n)){n.remove();continue}var q=n.querySelectorAll("meta");for(var k=0;k<q.length;k++)if(isRefresh(q[k]))q[k].remove()}}}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["http-equiv"]});
</script>`;

// App tokens are CSS custom properties — the sandboxed document can't
// see them, so they're baked in as literals at render time. Text color
// is NOT baked: a theme flip while the frame is mounted would strand
// dark-theme text on a light page. CanvasText follows the frame's own
// color-scheme, which tracks the system theme the app follows too.
// body is flow-root so a last child's margin can't collapse out of the
// measured box and clip the frame.
function baseStyle(): string {
	const fallback = { font: "system-ui, sans-serif", accent: "LinkText" };
	let vars = fallback;
	if (typeof document !== "undefined" && typeof getComputedStyle === "function") {
		const cs = getComputedStyle(document.documentElement);
		vars = {
			font: cs.getPropertyValue("--font-sans") || fallback.font,
			accent: cs.getPropertyValue("--app-accent") || fallback.accent,
		};
	}
	return `<style>:root{color-scheme:light dark}*{box-sizing:border-box}html,body{margin:0;padding:0;height:auto;background:transparent;color:CanvasText;font-family:${vars.font};font-size:13px;line-height:1.45}body{display:flow-root}a{color:${vars.accent}}button,input,select,textarea{font:inherit;color:inherit}</style>`;
}

export function srcdoc(html: string): string {
	// The CSP meta leads — anything before it would execute ungated.
	// Meta refresh is declarative navigation — CSP can't gate it — so it
	// is stripped before the document ever exists (quoted or bare
	// http-equiv values, attributes in any order).
	const body = html.replace(/<meta\b[^>]*http-equiv\s*=\s*(["'])?\s*refresh\s*\1[^>]*>/gi, "");
	return `<!doctype html>${CSP}${baseStyle()}${RESIZE}${NAVIGATION_GUARD}${body}`;
}

export function HtmlFrame({ leaf }: { leaf: Extract<UiLeaf, { type: "html" }> }) {
	const ref = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(360);
	const doc = useMemo(() => srcdoc(leaf.html), [leaf.html]);

	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			// Only this frame's own reports count — any window can
			// postMessage us a goblinUiHeight.
			if (e.source !== ref.current?.contentWindow) return;
			const data: unknown = e.data;
			const h =
				typeof data === "object" && data !== null
					? (data as Record<string, unknown>).goblinUiHeight
					: undefined;
			if (typeof h === "number" && Number.isFinite(h)) {
				setHeight(Math.min(900, Math.max(80, h)));
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);

	return (
		<div className="ui-html">
			<iframe
				ref={ref}
				className="ui-html-frame"
				sandbox="allow-scripts"
				srcDoc={doc}
				title={leaf.title}
				style={{ height }}
			/>
		</div>
	);
}
