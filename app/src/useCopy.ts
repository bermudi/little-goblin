// The copy affordance's feedback state, shared by every copy button
// (code blocks, tool output, message actions): a moment of "copied"
// or "failed", then back. The timer is per-consumer and cleared on
// unmount — a navigated-away view must never setState after death.
import { useCallback, useEffect, useRef, useState } from "react";

export function useCopy(): {
	copied: boolean;
	failed: boolean;
	copy(text: string): void;
} {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const seq = useRef(0);
	useEffect(
		() => () => {
			// A write resolving after unmount owns nothing.
			seq.current++;
			clearTimeout(timer.current);
		},
		[],
	);
	const copy = useCallback((text: string) => {
		// Only the newest click's verdict shows.
		const n = ++seq.current;
		const settle = (ok: boolean) => {
			if (n !== seq.current) return;
			setState(ok ? "copied" : "failed");
			clearTimeout(timer.current);
			timer.current = setTimeout(() => setState("idle"), 1500);
		};
		try {
			// A rejected write, a sync throw, and a missing clipboard
			// (non-secure context — lib.dom types it as always present)
			// all fail the same visible way; silence reads as a dead button.
			const clip: Clipboard | undefined = navigator.clipboard;
			if (clip === undefined || typeof clip.writeText !== "function") {
				settle(false);
				return;
			}
			void clip.writeText(text).then(
				() => settle(true),
				() => settle(false),
			);
		} catch {
			settle(false);
		}
	}, []);
	return { copied: state === "copied", failed: state === "failed", copy };
}
