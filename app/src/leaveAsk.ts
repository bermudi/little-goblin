// The leave guard's ask. It is an in-app sheet, not a blocking
// window.confirm, so the guarded page keeps running under it: the page
// hears "asking" when the sheet opens and the answer when it closes,
// and holds any autosave in between — a write under the sheet would
// make "Discard" a lie (#802). A late answer whose target is gone releases
// that hold as "stay" and is dropped.
import { useCallback, useRef } from "react";
import type { ConfirmRequest } from "./confirm.tsx";

export type LeaveAnswer = "asking" | "stay" | "discard";

// Resolves true (discard), false (stay), or null when superseded or when
// live says the target is gone; dropped answers release the hold as "stay".
export function useLeaveAsk(
	ask: (req: ConfirmRequest) => Promise<boolean>,
): (
	message: string,
	answer: (a: LeaveAnswer) => void,
	live?: () => boolean,
) => Promise<boolean | null> {
	const seq = useRef(0);
	return useCallback(
		async (message, answer, live) => {
			const mine = ++seq.current;
			const answered = ask({ message, confirmLabel: "Discard", danger: true });
			answer("asking");
			const ok = await answered;
			if (mine !== seq.current) return null;
			if (live !== undefined && !live()) {
				answer("stay");
				return null;
			}
			answer(ok ? "discard" : "stay");
			return ok;
		},
		[ask],
	);
}
