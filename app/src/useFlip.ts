import { useCallback, useLayoutEffect, useRef } from "react";

interface FlipState {
	signature: string | null;
	positions: Map<string, number> | null;
}

export function useFlip(signature: string): (node: HTMLElement | null) => void {
	const host = useRef<HTMLElement | null>(null);
	const state = useRef<FlipState>({ signature: null, positions: null });
	const setHost = useCallback((node: HTMLElement | null) => {
		if (host.current === node) return;
		host.current = node;
		state.current = { signature: null, positions: null };
	}, []);

	useLayoutEffect(() => {
		const element = host.current;
		const view = element?.ownerDocument.defaultView;
		if (!element || !view) return;

		const nodes = [...element.querySelectorAll<HTMLElement>("[data-flip]")];
		const positions = new Map<string, number>();
		for (const node of nodes) {
			const id = node.dataset.flip;
			if (id) positions.set(id, node.offsetTop);
		}

		const previous = state.current;
		const signatureChanged = previous.signature !== null && previous.signature !== signature;
		const animate = view.Element.prototype.animate;
		const reduced = typeof view.matchMedia === "function" &&
			view.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (signatureChanged && typeof animate === "function" && !reduced && previous.positions) {
			animateRows(nodes, positions, previous.positions);
		}

		state.current = { signature, positions };
	});

	return setHost;
}

function animateRows(
	nodes: HTMLElement[],
	positions: Map<string, number>,
	previous: Map<string, number>,
): void {
	for (const node of nodes) {
		const id = node.dataset.flip;
		if (!id) continue;
		const top = positions.get(id);
		if (top === undefined) continue;
		const oldTop = previous.get(id);
		if (oldTop === undefined) {
			node.animate([{ opacity: 0 }, { opacity: 1 }], {
				duration: 260,
				easing: "ease-out",
			});
		} else if (oldTop !== top) {
			node.animate([
				{ transform: `translateY(${oldTop - top}px)` },
				{ transform: "none" },
			], {
				duration: 260,
				easing: "cubic-bezier(.2,.8,.2,1)",
			});
		}
	}
}
