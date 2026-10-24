// Phone-width gate, shared by the shell and the chat (design/app.md →
// Mobile navigation): width-dependent chrome is gated in JSX on
// matchMedia, not CSS alone — navigation must not exist as hidden
// duplicates in a DOM that cannot use it.
import { useEffect, useState } from "react";

export const PHONE_QUERY = "(max-width: 720px)";

export function usePhoneWidth(): boolean {
	const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
	useEffect(() => {
		const mq = window.matchMedia(PHONE_QUERY);
		const onChange = (e: MediaQueryListEvent) => setPhone(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	return phone;
}
