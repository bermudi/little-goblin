// Conversation outline — DeepSeek's right-edge section rail, borrowed as
// a mechanism: one dash per operator message collapsed; hover or keyboard
// focus expands it into a card of titles; a click jumps the transcript to
// that message. The scroll spy highlights the section in view. It is a
// pointer/keyboard affordance, so ChatView mounts it only off phone
// widths (usePhoneWidth); the style sheet's phone display:none is its own
// guarantee. Flat and hairline per the design language — a background
// shift and 1px border, never a shadow.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { UIMessage } from "ai";

// The outline entry for one operator message: the first line of text, or
// the staged chip kind when the send carried media only.
export function outlineTitle(m: UIMessage): string {
	const text = m.parts
		.map((p) => (p.type === "text" ? p.text : ""))
		.join("\n")
		.trim();
	if (text !== "") return (text.split("\n")[0] ?? text).trim();
	if (m.parts.some((p) => p.type === "file")) return "attachment";
	if (m.parts.some((p) => p.type === "data-note")) return "note";
	if (m.parts.some((p) => p.type === "data-skill")) return "skill";
	return "message";
}

export function Outline({
	messages,
	scrollRef,
}: {
	messages: readonly UIMessage[];
	scrollRef: RefObject<HTMLDivElement | null>;
}) {
	// Sections are the operator's own messages — one dash each, in
	// transcript order. Assistant turns belong to the section above them.
	const anchors = useMemo(
		() =>
			messages.filter((m) => m.role === "user").map((m) => ({ id: m.id, title: outlineTitle(m) })),
		[messages],
	);
	const [current, setCurrent] = useState<string | null>(null);

	// The section in view is the last anchor at or above the viewport's
	// quarter mark. Scroll events re-run it; React drops the no-op sets.
	useEffect(() => {
		const el = scrollRef.current;
		if (el === null) return;
		const measure = () => {
			const origin = el.getBoundingClientRect().top;
			const limit = el.clientHeight * 0.25;
			let found: string | null = null;
			for (const node of el.querySelectorAll<HTMLElement>("[data-outline-anchor]")) {
				if (node.getBoundingClientRect().top - origin <= limit) {
					found = node.dataset.outlineAnchor ?? null;
				}
			}
			setCurrent(found);
		};
		measure();
		const onScroll = () => measure();
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [anchors, scrollRef]);

	const jump = (id: string) => {
		const el = scrollRef.current;
		if (el === null) return;
		const node = [...el.querySelectorAll<HTMLElement>("[data-outline-anchor]")].find(
			(n) => n.dataset.outlineAnchor === id,
		);
		if (node === undefined) return;
		// Near the top with a little headroom. The scroll event re-runs the
		// spy, and follow-mode unpins exactly the way any upward scroll does.
		el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
	};

	if (anchors.length === 0) return null;
	return (
		<nav className="outline" aria-label="Conversation outline">
			<ol>
				{anchors.map((a) => (
					<li key={a.id} className={a.id === current ? "current" : undefined}>
						<button
							type="button"
							title={a.title}
							aria-label={`Jump: ${a.title}`}
							aria-current={a.id === current ? "true" : undefined}
							onClick={() => jump(a.id)}
						>
							<span className="outline-title">{a.title}</span>
							<span className="outline-dash" aria-hidden="true" />
						</button>
					</li>
				))}
			</ol>
		</nav>
	);
}
