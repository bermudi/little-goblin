const SIDE_CHATS_KEY = "goblin.rail-side-chats-open.v1";

export function loadSideChatsOpen(): boolean {
	try {
		return localStorage.getItem(SIDE_CHATS_KEY) === "true";
	} catch {
		return false;
	}
}

export function saveSideChatsOpen(open: boolean): void {
	try {
		localStorage.setItem(SIDE_CHATS_KEY, String(open));
	} catch {
		return;
	}
}
