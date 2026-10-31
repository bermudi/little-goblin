// Native title tooltips are browser chrome — a pale OS panel the
// stylesheet can never reach. `title=` stays the semantic source in
// JSX; on hover or focus this moves the text into one shared bubble
// fixed to the viewport (no clipping inside scroll containers, no
// position:relative side effects on the host) and puts the attribute
// back when the hint ends — DOM readers, tests, and accessibility
// tooling never see the swap.
export function installTooltips(doc: Document): () => void {
	const tip = doc.createElement("div");
	tip.className = "tooltip";
	tip.setAttribute("aria-hidden", "true");
	doc.body.appendChild(tip);

	let host: Element | null = null;
	let saved: string | null = null;

	const hide = () => {
		tip.classList.remove("on");
		if (host !== null && saved !== null) host.setAttribute("title", saved);
		host = null;
		saved = null;
	};

	const show = (el: Element) => {
		if (el === host) return;
		hide();
		const text = el.getAttribute("title");
		if (text === null || text === "") return;
		// A hint that only repeats the host's own text earns its keep
		// solely when that text is clipped — ellipsized labels get the
		// tip, fully visible ones don't (an expanded outline row already
		// shows its title, so the bubble would be a verbatim echo).
		// Tips saying something new always show.
		if (
			el.textContent !== null &&
			el.textContent.trim() === text.trim() &&
			el.scrollWidth <= el.clientWidth &&
			el.scrollHeight <= el.clientHeight
		) {
			return;
		}
		host = el;
		saved = text;
		el.removeAttribute("title");
		tip.textContent = text;
		// The bubble is opacity:0 through its show delay, so it can be
		// measured and placed in the same frame it turns on — centered
		// above, flipped below when the top edge can't fit it, clamped
		// inside the viewport's near margin.
		tip.classList.add("on");
		const r = el.getBoundingClientRect();
		const gap = 7;
		const margin = 4;
		let top = r.top - tip.offsetHeight - gap;
		if (top < margin) top = r.bottom + gap;
		const left = Math.max(
			margin,
			Math.min(
				r.left + r.width / 2 - tip.offsetWidth / 2,
				doc.defaultView === null ? r.left : doc.defaultView.innerWidth - tip.offsetWidth - margin,
			),
		);
		tip.style.top = `${Math.round(top)}px`;
		tip.style.left = `${Math.round(left)}px`;
	};

	const titled = (e: Event): Element | null => {
		const t = e.target;
		if (t === null || !("closest" in t) || typeof t.closest !== "function") return null;
		return t.closest("[title]") as Element | null;
	};

	const over = (e: Event) => {
		const el = titled(e);
		if (el !== null) show(el);
	};
	// The host no longer carries [title] while stashed, so "leaving" is
	// judged by containment, not by the selector: a mouseout whose
	// relatedTarget is still inside the host is an inner crossing.
	const node = (v: unknown): Node | null =>
		v !== null && typeof v === "object" && "nodeType" in v ? (v as Node) : null;

	const out = (e: Event) => {
		if (host === null) return;
		const from = node(e.target);
		const to = node((e as MouseEvent).relatedTarget);
		if (from !== null && host.contains(from) && (to === null || !host.contains(to))) {
			hide();
		}
	};

	doc.addEventListener("mouseover", over);
	doc.addEventListener("mouseout", out);
	doc.addEventListener("focusin", over);
	doc.addEventListener("focusout", hide);
	// Clicks (a fold pill opening), scrolls (the fixed bubble would
	// orphan), and window blurs all end the hint outright.
	doc.addEventListener("pointerdown", hide, true);
	doc.addEventListener("scroll", hide, true);
	doc.defaultView?.addEventListener("blur", hide);
	return () => {
		hide();
		doc.removeEventListener("mouseover", over);
		doc.removeEventListener("mouseout", out);
		doc.removeEventListener("focusin", over);
		doc.removeEventListener("focusout", hide);
		doc.removeEventListener("pointerdown", hide, true);
		doc.removeEventListener("scroll", hide, true);
		doc.defaultView?.removeEventListener("blur", hide);
		tip.remove();
	};
}
