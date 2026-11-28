// The app client's URL space, known once. The server (mod.ts) serves the
// shell for exactly the paths parseAppPath accepts; the client (App.tsx)
// parses and pushes the same paths through it, so a page the client can
// push is a page the server can reload (#180).

/** Page keys that live at /app/<key> (and /t/<key> for the mini-app door). */
export const APP_PAGES = [
	"attention",
	"activity",
	"settings",
	"memory",
	"delegations",
	"programs",
	"status",
	"skills",
	"files",
	"log",
	"notes",
	"archive",
	"rolling",
] as const;
export type AppPageKey = (typeof APP_PAGES)[number];

const ID = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";

const PAGE_RE = new RegExp(`^/(app|t)/(${APP_PAGES.join("|")})/?$`);
const ID_ROUTE_RE = new RegExp(`^/app/(c|n|b)/(${ID})(/window)?$`);

export type AppPath =
	| { kind: "page"; page: AppPageKey }
	| { kind: "conversation"; id: string }
	| { kind: "window"; id: string }
	| { kind: "bot"; id: string }
	| { kind: "note"; id: string };

/** Parses a client URL path; null when it is not a page of the client. */
export function parseAppPath(pathname: string, door: "app" | "t" = "app"): AppPath | null {
	const page = PAGE_RE.exec(pathname);
	if (page !== null) {
		if (page[1] !== door || (door === "t" && page[2] === "rolling")) return null;
		return { kind: "page", page: page[2] as AppPageKey };
	}
	if (door !== "app") return null;
	const m = ID_ROUTE_RE.exec(pathname);
	if (m === null) return null;
	const id = m[2]!;
	const window = m[3] !== undefined;
	if (m[1] === "c") return window ? { kind: "window", id } : { kind: "conversation", id };
	if (window) return null;
	if (m[1] === "b") return { kind: "bot", id };
	return { kind: "note", id };
}
