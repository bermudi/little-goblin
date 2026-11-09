// window.confirm's in-app replacement: a question rendered in the app's
// own sheet chrome, answered by a promise instead of a blocked thread.
// The caller keeps `ask`, mounts `view` once — same shape as
// useUndoToast.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export type ConfirmRequest = {
	message: string;
	// The affirmative button's verb — "Delete", "Discard", "Forget".
	// Unset reads as the native box's OK.
	confirmLabel?: string;
	cancelLabel?: string;
	// Destructive asks put the confirm in .danger red.
	danger?: boolean;
};

type Shown = { id: number; req: ConfirmRequest };

export function useConfirm(): {
	ask: (req: ConfirmRequest) => Promise<boolean>;
	view: ReactNode;
} {
	const [shown, setShown] = useState<Shown | null>(null);
	const pending = useRef<((ok: boolean) => void) | null>(null);
	const seq = useRef(0);

	const answer = useCallback((ok: boolean) => {
		const resolve = pending.current;
		pending.current = null;
		setShown(null);
		resolve?.(ok);
	}, []);

	const ask = useCallback((req: ConfirmRequest) => {
		// One question at a time: a newer ask declines the one showing.
		pending.current?.(false);
		seq.current += 1;
		setShown({ id: seq.current, req });
		return new Promise<boolean>((resolve) => {
			pending.current = resolve;
		});
	}, []);

	// Escape declines wherever focus sits — the sheet doesn't trap it.
	useEffect(() => {
		if (shown === null) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") answer(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [shown, answer]);

	// A host unmounting with a question open must not hang its caller —
	// every call site treats unresolved as a decline.
	useEffect(() => () => pending.current?.(false), []);

	const view =
		shown === null ? null : (
			<div className="veil confirm-veil" key={shown.id} onClick={() => answer(false)}>
				<div
					className="msheet confirm-sheet"
					role="alertdialog"
					aria-label="Confirm"
					onClick={(e) => e.stopPropagation()}
				>
					<div className="confirm-body">
						<p className="confirm-msg">{shown.req.message}</p>
						<div className="confirm-actions">
							<button
								type="button"
								className="ghost confirm-cancel"
								onClick={() => answer(false)}
							>
								{shown.req.cancelLabel ?? "Cancel"}
							</button>
							<button
								type="button"
								className={shown.req.danger === true ? "danger confirm-ok" : "confirm-ok"}
								autoFocus
								onClick={() => answer(true)}
							>
								{shown.req.confirmLabel ?? "OK"}
							</button>
						</div>
					</div>
				</div>
			</div>
		);
	return { ask, view };
}
