import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { AT_END_PX, distanceToEnd } from "./useTranscriptFollow.ts";

export function useFoldFollow(
	fold: RefObject<HTMLDetailsElement | null>,
	list: RefObject<HTMLUListElement | null>,
	parts: readonly unknown[],
	active: boolean,
): void {
	const atEnd = useRef(true);
	useEffect(() => {
		const details = fold.current;
		const el = list.current;
		if (details === null || el === null) return;
		const track = () => {
			atEnd.current = distanceToEnd(el) < AT_END_PX;
		};
		el.addEventListener("scroll", track, { passive: true });
		details.addEventListener("toggle", track);
		return () => {
			el.removeEventListener("scroll", track);
			details.removeEventListener("toggle", track);
		};
	}, [fold, list]);
	useLayoutEffect(() => {
		const el = list.current;
		if (el !== null && active && fold.current?.open === true && atEnd.current)
			el.scrollTop = el.scrollHeight;
	}, [fold, list, parts, active]);
}
