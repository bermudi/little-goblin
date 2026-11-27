import { z } from "zod";

const HEADER_LAYOUT = z.enum(["a", "b"]);
type HeaderLayout = z.infer<typeof HEADER_LAYOUT>;
const KEY = "goblin.headerLayout";

function storeLayout(layout: HeaderLayout): HeaderLayout {
	try {
		localStorage.setItem(KEY, layout);
	} catch {
		return layout;
	}
	return layout;
}

export function readHeaderLayout(): HeaderLayout {
	try {
		const fromQuery = HEADER_LAYOUT.safeParse(new URLSearchParams(location.search).get("header"));
		if (fromQuery.success) return storeLayout(fromQuery.data);
		const stored = HEADER_LAYOUT.safeParse(localStorage.getItem(KEY));
		return stored.success ? stored.data : "a";
	} catch {
		return "a";
	}
}
