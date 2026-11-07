// Conversation outline — t3code's timeline minimap, borrowed as a
// mechanism and mirrored to the right edge: one dash per operator message,
// spaced evenly on a rail. Hovering (or arrowing) fans the dashes out
// around the pointer like a dock — transform and opacity only, so every
// frame stays on the compositor — and one floating card shows the section
// under it: the operator's message plus the first lines of the reply. A
// click jumps the transcript there; the scroll spy lights the section in
// view. Each dash's hit slot is the band nearest to it, so the pointer
// never crosses a dead gap. A pointer/keyboard affordance: ChatView mounts
// it only off phone widths (usePhoneWidth); the style sheet's phone
// display:none is its own guarantee. Flat and hairline per the design
// language — a background shift and 1px border, never a shadow.

import type { UIMessage } from "ai";
import { type KeyboardEvent, type RefObject, useEffect, useMemo, useState } from "react";

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

const SPACING_PX = 8;
const EDGE_PX = 6;
// Fisheye widths by distance from the hovered dash — t3code's ratios.
const FAN = [1, 0.667, 0.417] as const;
const REST_SCALE = 0.333;
const PREVIEW_CHARS = 400;

// First lines of the section's reply, whitespace squashed — the card
// clamps to three lines, so the bound only keeps long replies cheap.
export function outlinePreview(replies: readonly UIMessage[]): string | null {
	const last = replies.at(-1);
	if (last === undefined) return null;
	const text = last.parts
		.map((p) => (p.type === "text" ? p.text : ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return text === "" ? null : text.slice(0, PREVIEW_CHARS);
}

type Anchor = { id: string; title: string; preview: string | null };

// Compositor-only wheel forwarding: the rail floats over the transcript,
// so a wheel over it must still scroll the transcript.
function forwardWheel(event: WheelEvent, el: HTMLElement) {
	if (event.ctrlKey || event.deltaY === 0) return;
	event.preventDefault();
	const px = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
	const coarse = event.deltaMode !== 0 || Number.isInteger(event.deltaY / 100);
	el.scrollBy({ top: event.deltaY * px, behavior: coarse ? "smooth" : "auto" });
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
	const anchors = useMemo(() => {
		const out: Anchor[] = [];
		let replies: UIMessage[] = [];
		const close = () => {
			const last = out.at(-1);
			if (last !== undefined) last.preview = outlinePreview(replies);
			replies = [];
		};
		for (const m of messages) {
			if (m.role === "user") {
				close();
				out.push({ id: m.id, title: outlineTitle(m), preview: null });
			} else if (m.role === "assistant") {
				replies.push(m);
			}
		}
		close();
		return out;
	}, [messages]);
	const [current, setCurrent] = useState<string | null>(null);
	const [active, setActive] = useState<number | null>(null);
	// The spy re-measures when the section set changes, not when `messages`
	// changes identity — every stream chunk is a fresh array, and
	// re-measuring per token is forced layout for nothing. Scroll events
	// already cover pure view changes.
	const anchorKey = anchors.map((a) => a.id).join("\n");

	// The section in view is the last anchor at or above the viewport's
	// quarter mark — except at the tail, where the last section owns the
	// view even when its anchor rests below the mark. The 48px tolerance
	// is the transcript's own pin threshold: the rail must agree with
	// follow-mode about where "the bottom" is. A transcript too short to
	// overflow has no tail and keeps the quarter-mark rule. Scroll
	// events re-run it; React drops the no-op sets.
	useEffect(() => {
		const el = scrollRef.current;
		if (el === null) return;
		const measure = () => {
			const origin = el.getBoundingClientRect().top;
			const limit = el.clientHeight * 0.25;
			let found: string | null = null;
			let last: string | null = null;
			for (const node of el.querySelectorAll<HTMLElement>("[data-outline-anchor]")) {
				last = node.dataset.outlineAnchor ?? null;
				if (node.getBoundingClientRect().top - origin <= limit) {
					found = last;
				}
			}
			if (
				el.scrollHeight > el.clientHeight &&
				el.scrollHeight - el.scrollTop - el.clientHeight < 48
			) {
				found = last;
			}
			setCurrent(found);
		};
		measure();
		const onScroll = () => measure();
		el.addEventListener("scroll", onScroll, { passive: true });
		// Relayout can move anchors without a scroll ever firing — the
		// narrow/wide toggle, window resizes, images settling — so the
		// transcript box and its content re-run the spy on resize.
		const observer = new window.ResizeObserver(() => measure());
		observer.observe(el);
		const content = el.firstElementChild;
		if (content !== null) observer.observe(content);
		return () => {
			el.removeEventListener("scroll", onScroll);
			observer.disconnect();
		};
	}, [anchorKey, scrollRef]);

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

	const count = anchors.length;
	const [rail, setRail] = useState<HTMLElement | null>(null);
	useEffect(() => {
		if (rail === null) return;
		const onWheel = (e: WheelEvent) => {
			const el = scrollRef.current;
			if (el !== null) forwardWheel(e, el);
		};
		rail.addEventListener("wheel", onWheel, { passive: false });
		return () => rail.removeEventListener("wheel", onWheel);
	}, [rail, scrollRef]);

	if (count === 0) return null;
	const shown = active !== null && active < count ? active : null;
	const card = shown === null ? null : (anchors[shown] ?? null);
	// Percent of the track: first dash on the top edge, last on the bottom.
	const topPct = (i: number) => (count <= 1 ? 0 : (i / (count - 1)) * 100);
	const scaleFor = (i: number) => {
		if (shown === null) return REST_SCALE;
		return FAN[Math.abs(i - shown)] ?? REST_SCALE;
	};
	const currentIdx = anchors.findIndex((x) => x.id === current);
	const tabStop = shown ?? (currentIdx === -1 ? 0 : currentIdx);
	const cardShift = shown === 0 ? "0%" : shown === count - 1 ? "-100%" : "-50%";

	// Roving focus: one tab stop, arrows move between dashes.
	const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
		const next =
			e.key === "ArrowDown"
				? Math.min(count - 1, (shown ?? 0) + 1)
				: e.key === "ArrowUp"
					? Math.max(0, (shown ?? 0) - 1)
					: e.key === "Home"
						? 0
						: e.key === "End"
							? count - 1
							: null;
		if (next === null) return;
		e.preventDefault();
		setActive(next);
		e.currentTarget.querySelectorAll<HTMLElement>("button")[next]?.focus();
	};

	return (
		<nav
			className="outline"
			aria-label="Conversation outline"
			ref={setRail}
			style={{ "--outline-count": Math.max(1, count - 1) } as React.CSSProperties}
			onMouseLeave={() => setActive(null)}
			onBlur={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget)) setActive(null);
			}}
		>
			<ol onKeyDown={onKeyDown}>
				{anchors.map((a, i) => {
					const isCurrent = a.id === current;
					const slotTop = i === 0 ? `-${EDGE_PX}px` : `${((i - 0.5) / (count - 1)) * 100}%`;
					const slotEnd =
						i === count - 1 ? `-${EDGE_PX}px` : `${(1 - (i + 0.5) / (count - 1)) * 100}%`;
					return (
						<li key={a.id} className={isCurrent ? "current" : undefined}>
							<span
								className="outline-dash"
								aria-hidden="true"
								data-active={i === shown ? "true" : "false"}
								style={{
									top: `${topPct(i)}%`,
									transform: `translateY(-50%) scaleX(${scaleFor(i)})`,
								}}
							/>
							<button
								type="button"
								aria-label={`Jump: ${a.title}`}
								aria-current={isCurrent ? "true" : undefined}
								tabIndex={i === tabStop ? 0 : -1}
								style={
									count === 1
										? { top: `-${EDGE_PX}px`, bottom: `-${EDGE_PX}px` }
										: { top: slotTop, bottom: slotEnd }
								}
								onMouseEnter={() => setActive(i)}
								onFocus={() => setActive(i)}
								onClick={() => jump(a.id)}
							/>
						</li>
					);
				})}
			</ol>
			{card === null ? null : (
				<div
					className="outline-card-wrap"
					style={{ top: `${topPct(shown ?? 0)}%`, transform: `translateY(${cardShift})` }}
				>
					<div className="outline-card">
						<span className="outline-card-title">{card.title}</span>
						{card.preview === null ? null : (
							<span className="outline-card-preview">{card.preview}</span>
						)}
					</div>
				</div>
			)}
		</nav>
	);
}
