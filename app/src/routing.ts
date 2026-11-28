import { type AppPageKey, parseAppPath } from "../../src/http/app-routes.ts";

// `project` and `note` carry ids parsed separately (/app/p/<id>,
// /app/n/<id>) — the union holds the page key only.
// Every page key is also a server shell path (src/http/app-routes.ts).
export type Page = "chat" | "project" | "bot" | "note" | "window" | AppPageKey;
export type Route =
	| {
			kind: "home";
			// On phones, "+" stages the empty-state composer from the chats
			// list. Desktop /app is always the composer and ignores this flag.
			composing: boolean;
			botId?: string;
		}
	| { kind: "conversation"; id: string }
	| { kind: "window"; id: string }
	| { kind: "project"; id: string }
	| { kind: "bot"; id: string; tab: "settings" | "memory" }
	| { kind: "note"; id: string }
	| { kind: "page"; page: AppPageKey };

export function routeFromPath(pathname: string): Route {
	const parsed = parseAppPath(pathname) ?? parseAppPath(pathname, "t");
	if (parsed === null) return { kind: "home", composing: false };
	switch (parsed.kind) {
		case "conversation":
		case "window":
			return { kind: parsed.kind, id: `app/${parsed.id}` };
		case "bot-compose":
			return { kind: "home", composing: true, botId: parsed.id };
		case "project":
		case "bot":
		case "note":
			return parsed;
		case "page":
			return { kind: "page", page: parsed.page };
	}
}

export function openingRoute(pathname: string, historyState: unknown): Route {
	const route = routeFromPath(pathname);
	if (route.kind === "conversation") return { kind: "home", composing: false };
	if (route.kind === "home" && !route.composing && historyPosition(historyState) === null)
		return { kind: "page", page: "rolling" };
	return route;
}

export function pathOfRoute(route: Route): string {
	switch (route.kind) {
		case "home":
			return route.botId === undefined ? "/app/" : `/app/b/${route.botId}/new`;
		case "conversation":
			return `/app/c/${route.id.slice("app/".length)}`;
		case "window":
			return `/app/c/${route.id.slice("app/".length)}/window`;
		case "project":
			return `/app/p/${route.id}`;
		case "bot":
			return `/app/b/${route.id}${route.tab === "memory" ? "/memory" : ""}`;
		case "note":
			return `/app/n/${route.id}`;
		case "page":
			return `/app/${route.page}`;
	}
}

export function sameRoute(a: Route, b: Route): boolean {
	if (a.kind !== b.kind) return false;
	switch (a.kind) {
		case "home":
			return b.kind === "home" && a.composing === b.composing && a.botId === b.botId;
		case "page":
			return b.kind === "page" && a.page === b.page;
		case "conversation":
		case "window":
		case "project":
		case "note":
			return b.kind === a.kind && a.id === b.id;
		case "bot":
			return b.kind === "bot" && a.id === b.id && a.tab === b.tab;
	}
}

export const PAGES: { key: Exclude<AppPageKey, "notes" | "rolling">; label: string }[] = [
	{ key: "attention", label: "Attention" },
	{ key: "activity", label: "Activity" },
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
