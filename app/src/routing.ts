import { type AppPageKey, parseAppPath } from "../../src/http/app-routes.ts";

// `project` and `note` carry ids parsed separately (/app/p/<id>,
// /app/n/<id>) — the union holds the page key only.
// Every page key is also a server shell path (src/http/app-routes.ts).
export type Page = "chat" | "project" | "note" | "window" | AppPageKey;

export const PAGES: { key: Exclude<AppPageKey, "notes">; label: string }[] = [
	{ key: "attention", label: "Attention" },
	{ key: "settings", label: "Settings" },
	{ key: "memory", label: "Memories" },
	{ key: "delegations", label: "Delegations" },
	{ key: "programs", label: "Programs" },
	{ key: "status", label: "Status" },
	{ key: "skills", label: "Skills" },
	{ key: "files", label: "Files" },
	{ key: "log", label: "Log" },
];

// The URL space lives in src/http/app-routes.ts, shared with the server's
// shell dispatch — a path the client can push is a path a reload can load.
export function pageFromPath(pathname: string): Page | null {
	// Both doors serve this bundle: /app/ the PWA, /t/ the Telegram mini
	// app — each door clamps the result to its own page scope.
	const route = parseAppPath(pathname) ?? parseAppPath(pathname, "t");
	return route?.kind === "page" ? route.page : null;
}

// /app/p/<projectId> — project ids are server-minted randomUUIDs, the
// same url-safe shape the /app/c/ link checks.
export function projectFromPath(pathname: string): string | null {
	const route = parseAppPath(pathname);
	return route?.kind === "project" ? route.id : null;
}

// /app/n/<noteId> — same id shape as projects.
export function noteFromPath(pathname: string): string | null {
	const route = parseAppPath(pathname);
	return route?.kind === "note" ? route.id : null;
}

// /app/c/<appId>/window — the context-window view of one conversation.
export function windowFromPath(pathname: string): string | null {
	const route = parseAppPath(pathname);
	return route?.kind === "window" ? `app/${route.id}` : null;
}

// /app/c/<appId> opens one conversation — the id matches the server's
// appIdSchema; the conversation id is "app/<appId>".
export function deepLinkConv(pathname: string): string | null {
	const route = parseAppPath(pathname);
	return route?.kind === "conversation" ? `app/${route.id}` : null;
}

export function historyPosition(state: unknown): { index: number; segment: string } | null {
	if (
		typeof state !== "object" ||
		state === null ||
		!("goblinIndex" in state) ||
		typeof state.goblinIndex !== "number" ||
		!Number.isSafeInteger(state.goblinIndex) ||
		!("goblinSegment" in state) ||
		typeof state.goblinSegment !== "string"
	)
		return null;
	return { index: state.goblinIndex, segment: state.goblinSegment };
}

export const newHistorySegment = () => crypto.getRandomValues(new Uint32Array(2)).join("-");

export interface BrowserNavigation {
	readonly currentEntry: { readonly key: string };
	traverseTo(key: string): {
		committed: Promise<unknown>;
		finished: Promise<unknown>;
	};
}

// Native keys also identify entries created before we started tagging history.
// DOM typings don't yet expose Window.navigation.
export function browserNavigation(): BrowserNavigation | null {
	const value: unknown = Reflect.get(window, "navigation");
	if (
		typeof value !== "object" ||
		value === null ||
		!("traverseTo" in value) ||
		typeof value.traverseTo !== "function" ||
		!("currentEntry" in value) ||
		typeof value.currentEntry !== "object" ||
		value.currentEntry === null ||
		!("key" in value.currentEntry) ||
		typeof value.currentEntry.key !== "string"
	)
		return null;
	return value as BrowserNavigation;
}
