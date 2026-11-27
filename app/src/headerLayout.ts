import { z } from "zod";

const HEADER_LAYOUT = z.enum(["a", "b"]);
const KEY = "goblin.headerLayout";

export function readHeaderLayout(): "a" | "b" {
	try {
		const query = new URLSearchParams(location.search).get("header");
		const fromQuery = HEADER_LAYOUT.safeParse(query);
		if (fromQuery.success) {
			try {
				localStorage.setItem(KEY, fromQuery.data);
			} catch {}
			return fromQuery.data;
		}
	} catch {}
	try {
		const stored = HEADER_LAYOUT.safeParse(localStorage.getItem(KEY));
		return stored.success ? stored.data : "a";
	} catch {
		return "a";
	}
}
