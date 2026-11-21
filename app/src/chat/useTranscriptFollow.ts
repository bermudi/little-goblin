import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type Follow =
	| { kind: "tail" }
	| { kind: "reply"; after: string }
	| { kind: "free" };

export type ScrollDirection = "up" | "down";

export const AT_END_PX = 48;
export const REPLY_HEAD_GAP_PX = 24;
const UP_KEYS = new Set(["PageUp", "ArrowUp", "Home"]);
const TYPING = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

export function distanceToEnd(el: Element): number {
	return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function replyHead(scroller: Element, afterId: string): Element | null {
	const asked = [...scroller.querySelectorAll("[data-outline-anchor]")].find(
		(node) => node.getAttribute("data-outline-anchor") === afterId,
	);
	for (let row = asked?.nextElementSibling ?? null; row !== null; row = row.nextElementSibling) {
		if (row.matches(".msg.user")) return null;
		if (row.matches(".msg.assistant:not(.pending)")) return row;
	}
	return null;
}

export function followTarget(
	scroller: Element,
	follow: Follow,
): { top: number; next: Follow } | null {
	if (follow.kind === "free") return null;
	const end = scroller.scrollHeight - scroller.clientHeight;
	if (follow.kind === "tail") return { top: end, next: follow };
	const head = replyHead(scroller, follow.after);
	if (head === null) return { top: end, next: follow };
	const headTop =
		head.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
	const holdAt = headTop - REPLY_HEAD_GAP_PX;
	return holdAt < end ? { top: holdAt, next: { kind: "free" } } : { top: end, next: follow };
}

export function afterUserScroll(
	follow: Follow,
	move: { from: number; to: number; atEnd: boolean },
): Follow {
	if (move.atEnd) return { kind: "tail" };
	return move.to < move.from - 1 ? { kind: "free" } : follow;
}

export function useTranscriptFollow(
	scrollRef: RefObject<HTMLDivElement | null>,
	contentRef: RefObject<HTMLDivElement | null>,
) {
	const follow = useRef<Follow>({ kind: "tail" });
	const ownTop = useRef<number | null>(null);
	const [below, setBelow] = useState(false);

	const scrollTo = useCallback((el: HTMLElement, top: number) => {
		const before = el.scrollTop;
		el.scrollTop = top;
		if (el.scrollTop !== before) ownTop.current = el.scrollTop;
	}, []);

	const stick = useCallback(() => {
		const el = scrollRef.current;
		if (el === null) return;
		const target = followTarget(el, follow.current);
		if (target !== null) {
			follow.current = target.next;
			if (target.top > el.scrollTop) scrollTo(el, target.top);
		}
		setBelow(distanceToEnd(el) >= AT_END_PX);
	}, [scrollRef, scrollTo]);

	const gesture = useCallback((direction: ScrollDirection) => {
		if (direction === "up") follow.current = { kind: "free" };
	}, []);

	const followReply = useCallback(
		(afterMessageId: string) => {
			follow.current = { kind: "reply", after: afterMessageId };
			stick();
		},
		[stick],
	);

	const jumpToEnd = useCallback(() => {
		const el = scrollRef.current;
		follow.current = { kind: "tail" };
		if (el !== null) scrollTo(el, el.scrollHeight - el.clientHeight);
		setBelow(false);
	}, [scrollRef, scrollTo]);

	useEffect(() => {
		const el = scrollRef.current;
		const content = contentRef.current;
		const doc = el?.ownerDocument;
		const view = doc?.defaultView;
		if (el === null || content === null || doc === undefined || view == null) return;
		const observer = new view.ResizeObserver(stick);
		observer.observe(el);
		observer.observe(content);
		let lastTop = el.scrollTop;
		let touchY: number | null = null;
		const onWheel = (e: WheelEvent) => {
			if (e.deltaY < 0) gesture("up");
		};
		const onTouchStart = (e: TouchEvent) => {
			touchY = e.touches[0]?.clientY ?? null;
		};
		const onTouchMove = (e: TouchEvent) => {
			const y = e.touches[0]?.clientY ?? null;
			if (touchY !== null && y !== null && y > touchY) gesture("up");
			touchY = y;
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (!UP_KEYS.has(e.key)) return;
			const target = e.target;
			if (target === doc.body) gesture("up");
			else if (target instanceof view.Element && el.contains(target) && target.closest(TYPING) === null)
				gesture("up");
		};
		const onScroll = () => {
			const top = el.scrollTop;
			const atEnd = distanceToEnd(el) < AT_END_PX;
			const ours = ownTop.current !== null && Math.abs(top - ownTop.current) < 1;
			if (!ours) follow.current = afterUserScroll(follow.current, { from: lastTop, to: top, atEnd });
			ownTop.current = null;
			lastTop = top;
			setBelow(!atEnd);
		};
		el.addEventListener("wheel", onWheel, { passive: true });
		el.addEventListener("touchstart", onTouchStart, { passive: true });
		el.addEventListener("touchmove", onTouchMove, { passive: true });
		doc.addEventListener("keydown", onKeyDown);
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			observer.disconnect();
			el.removeEventListener("wheel", onWheel);
			el.removeEventListener("touchstart", onTouchStart);
			el.removeEventListener("touchmove", onTouchMove);
			doc.removeEventListener("keydown", onKeyDown);
			el.removeEventListener("scroll", onScroll);
		};
	}, [scrollRef, contentRef, stick, gesture]);

	return { stick, gesture, followReply, jumpToEnd, below };
}
