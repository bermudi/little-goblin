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
	} catch {
		return;
	}
}

const SECTION_KEY = "goblin.rail-projects-open.v1";

export function loadProjectsOpen(): boolean {
	try {
		return localStorage.getItem(SECTION_KEY) === "true";
	} catch {
		return false;
	}
}

export function saveProjectsOpen(open: boolean): void {
	try {
		localStorage.setItem(SECTION_KEY, String(open));
	} catch {
		return;
	}
}
