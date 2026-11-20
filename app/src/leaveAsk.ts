// The leave guard's ask. It is an in-app sheet, not a blocking
// window.confirm, so the guarded page keeps running under it: the page
// hears "asking" when the sheet opens and the answer when it closes,
// and holds any autosave in between — a write under the sheet would
// make "Discard" a lie (#802).
import { useCallback, useRef } from "react";
import type { ConfirmRequest } from "./confirm.tsx";

export type LeaveAnswer = "asking" | "stay" | "discard";

// Resolves true (discard), false (stay), or null when a newer ask
// superseded this one — that answer is not passed on, so it can't
// release a page the newer ask still holds.
export function useLeaveAsk(
	ask: (req: ConfirmRequest) => Promise<boolean>,
): (message: string, answer: (a: LeaveAnswer) => void) => Promise<boolean | null> {
	const seq = useRef(0);
	return useCallback(
		async (message, answer) => {
			const mine = ++seq.current;
			const answered = ask({ message, confirmLabel: "Discard", danger: true });
			answer("asking");
			const ok = await answered;
			if (mine !== seq.current) return null;
			answer(ok ? "discard" : "stay");
			return ok;
		},
		[ask],
	);
}
