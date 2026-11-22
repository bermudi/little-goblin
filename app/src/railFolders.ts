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
