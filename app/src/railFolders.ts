import { z } from "zod";

const KEY = "goblin.rail-folders.v1";
const IDS = z.array(z.string());

export function loadOpenFolders(): Set<string> {
	try {
		const raw = localStorage.getItem(KEY);
		if (raw === null) return new Set();
		const parsed: unknown = JSON.parse(raw);
		const result = IDS.safeParse(parsed);
		return result.success ? new Set(result.data) : new Set();
	} catch {
		return new Set();
	}
}

export function saveOpenFolders(ids: ReadonlySet<string>): void {
	try {
		localStorage.setItem(KEY, JSON.stringify([...ids]));
	} catch {}
}
