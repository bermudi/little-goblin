// Chat column width preference: same-origin localStorage, per device —
// a phone and a desktop PWA legitimately want different columns. A
// preference, not state: storage being unavailable only costs the
// memory of it (speech.tsx's rate ruling).

import { z } from "zod";

const WIDTH_SCHEMA = z.enum(["narrow", "wide"]);

export type ChatWidth = z.infer<typeof WIDTH_SCHEMA>;

const KEY = "goblin.chat-width.v1";

export function loadChatWidth(): ChatWidth {
	try {
		const raw = localStorage.getItem(KEY);
		if (raw === null) return "narrow";
		const res = WIDTH_SCHEMA.safeParse(raw);
		return res.success ? res.data : "narrow";
	} catch {
		return "narrow";
	}
}

export function saveChatWidth(width: ChatWidth): void {
	try {
		localStorage.setItem(KEY, WIDTH_SCHEMA.parse(width));
	} catch {
		// preference persistence is best-effort
	}
}
