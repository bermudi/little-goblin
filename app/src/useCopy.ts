// The copy affordance's feedback state, shared by every copy button
// (code blocks, tool output, message actions): a moment of "copied",
// then back. The timer is per-consumer and cleared on unmount — a
// navigated-away view must never setState after death.
import { useCallback, useEffect, useRef, useState } from "react";

export function useCopy(): { copied: boolean; copy(text: string): void } {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = useCallback((text: string) => {
		// The ✓ is a claim — only on a resolved write. A denied
		// permission or non-secure context leaves the button unchanged
		// rather than lying about a copy that never happened.
		void navigator.clipboard.writeText(text).then(
			() => {
				setCopied(true);
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), 1500);
			},
			() => {},
		);
	}, []);
	return { copied, copy };
}
