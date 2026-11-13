// The composer's focus claiming: the caller's focusSignal, and the
// thread view's stealFocus — focus at the moments the next keystroke
// is a reply, never against a surface typing for itself.

import { useEffect, useRef, type RefObject } from "react";
import { usePhoneWidth } from "../usePhoneWidth.ts";

export function useKeyboard({
	textareaRef,
	focusSignal,
	stealFocus,
	busy,
	pickersOpen,
}: {
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	// Bumped by the caller when the composer should grab focus (the
	// "New conversation" click) — covers the already-mounted case that
	// an autoFocus attribute can't.
	focusSignal?: number | undefined;
	// The thread view's composer claims focus when it can: on mount and
	// whenever a turn settles (operator ask, 2026-11-07). One-way — the
	// conversation-less composers keep their explicit focusSignal only.
	stealFocus?: boolean | undefined;
	busy: boolean;
	// Any composer popover open — the pickers, the model menu or sheet.
	pickersOpen: boolean;
}) {
	useEffect(() => {
		if ((focusSignal ?? 0) > 0) textareaRef.current?.focus();
	}, [focusSignal]);

	// Focus stealing (`stealFocus`, the thread view): on mount, at every
	// busy → idle settle, and when the window comes back to the
	// foreground — the moments the next keystroke is a reply — the
	// composer claims focus, so typing never needs a click first. "When
	// it can": never against a surface holding focus for its own typing
	// (matched by tag/contenteditable — bare DOM classes like
	// HTMLElement don't exist in bun's test runtime), never while a
	// composer popover is open — pickersOpen rides a ref so the
	// window-focus listener's closure stays fresh without re-subscribing —
	// the `.composer-pick` DOM check covers popovers whose state lives
	// elsewhere, the context gauge's — never under any dialog, and
	// never on phone widths, where focus() pops the on-screen keyboard
	// over a thread the operator just opened to read. The refocus claim
	// skips the busy check deliberately: coming back to a streaming
	// turn to steer it is still typing into the box.
	const stealGuard = useRef({ pickers: false });
	stealGuard.current.pickers = pickersOpen;
	const phone = usePhoneWidth();
	const claimFocus = () => {
		// activeElement is an HTMLElement in practice; the cast only
		// reaches isContentEditable, which Element lacks.
		const el = document.activeElement as HTMLElement | null;
		if (el != null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))
			return;
		if (stealGuard.current.pickers) return;
		if (document.querySelector(".composer-pick") !== null) return;
		if (document.querySelector('[role="dialog"]') !== null) return;
		textareaRef.current?.focus();
	};
	useEffect(() => {
		if (!stealFocus || phone || busy) return;
		claimFocus();
	}, [stealFocus, phone, busy]);
	useEffect(() => {
		if (!stealFocus || phone) return;
		const onWinFocus = () => claimFocus();
		window.addEventListener("focus", onWinFocus);
		return () => window.removeEventListener("focus", onWinFocus);
	}, [stealFocus, phone]);
}
