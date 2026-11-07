import { useCallback, useEffect, useRef, useState } from "react";

// How long Undo stays on screen. A delete is held back for the same
// window (design/app.md → Undo), so this is also the delete's grace.
export const UNDO_MS = 6000;

export type UndoAction = {
	message: string;
	// Reverses the action. Runs only from the Undo button.
	undo: () => void;
	// Makes the action final. Runs when the toast times out, is closed,
	// is replaced by a newer one, or the page is hidden — never after undo.
	settle?: () => void;
};

type Shown = { id: number; message: string };

// One toast at a time: a newer action settles the older one, so only the
// latest action is undoable.
export function useUndoToast(): {
	show: (action: UndoAction) => void;
	view: React.ReactNode;
} {
	const [shown, setShown] = useState<Shown | null>(null);
	const current = useRef<UndoAction | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const seq = useRef(0);

	const take = useCallback((): UndoAction | null => {
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = null;
		const action = current.current;
		current.current = null;
		setShown(null);
		return action;
	}, []);
	const settle = useCallback(() => take()?.settle?.(), [take]);
	const undo = useCallback(() => take()?.undo(), [take]);

	const show = useCallback(
		(action: UndoAction) => {
			settle();
			current.current = action;
			seq.current += 1;
			setShown({ id: seq.current, message: action.message });
			timer.current = setTimeout(settle, UNDO_MS);
		},
		[settle],
	);

	// Best effort: a request fired as the page unloads may not land, in
	// which case a held delete simply didn't happen.
	useEffect(() => {
		window.addEventListener("pagehide", settle);
		return () => {
			window.removeEventListener("pagehide", settle);
			if (timer.current !== null) clearTimeout(timer.current);
		};
	}, [settle]);

	const view =
		shown === null ? null : (
			<div className="undo-toast" role="status" key={shown.id}>
				<span className="undo-message">{shown.message}</span>
				<button type="button" className="undo-action" onClick={undo}>
					Undo
				</button>
				<button type="button" className="undo-close" onClick={settle} aria-label="Dismiss">
					×
				</button>
			</div>
		);
	return { show, view };
}
