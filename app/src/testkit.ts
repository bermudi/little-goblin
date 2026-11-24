// App-side test helpers (the server suite's namesake is src/testkit.ts).
// The in-app confirm (confirm.tsx) renders real DOM — tests answer it by
// clicking its buttons, the way the operator would.
import { createElement, type ReactElement, type ReactNode } from "react";
import { LiveStore } from "./live.ts";
import { LiveProvider } from "./useLive.tsx";

export function confirmSheet(root: ParentNode): HTMLElement | null {
	return root.querySelector<HTMLElement>('[role="alertdialog"]');
}

export function confirmText(root: ParentNode): string | null {
	return confirmSheet(root)?.querySelector(".confirm-msg")?.textContent ?? null;
}

export function clickConfirm(root: ParentNode, ok: boolean): void {
	const button = confirmSheet(root)?.querySelector<HTMLElement>(
		ok ? ".confirm-ok" : ".confirm-cancel",
	);
	if (button === null || button === undefined) throw new Error("no confirm sheet is open");
	button.click();
}

export const LIST_ENTRY = { goblinIndex: 0, goblinSegment: "test" };

const liveEncoder = new TextEncoder();

export const goblinLive: {
	feed: ReadableStreamDefaultController<Uint8Array> | null;
} = { feed: null };

export function emitLiveVersions(versions: Record<string, string>): void {
	goblinLive.feed?.enqueue(
		liveEncoder.encode(`data: ${JSON.stringify({ type: "versions", versions })}\n\n`),
	);
}

export function goblinFeedResponse(url: string): Response | null {
	if (url === "/api/app/activity") return Response.json({ busy: [], otherBusy: 0, posts: [] });
	if (url === "/api/app/delegations") return Response.json({ delegations: [] });
	if (url === "/api/app/programs") return Response.json({ programs: [] });
	if (url === "/api/app/live") {
		return new Response(
			new ReadableStream({
				start(controller) {
					goblinLive.feed = controller;
					controller.enqueue(
						liveEncoder.encode('data: {"type":"versions","versions":{}}\n\n'),
					);
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
	}
	return null;
}

export function withLive(node: ReactNode, store?: LiveStore): ReactElement {
	return createElement(LiveProvider, { store: store ?? new LiveStore(null), children: node });
}

export type DesktopPage =
	| "Settings"
	| "Archive"
	| "Projects"
	| "Notes"
	| "Status"
	| "Memory"
	| "Delegations"
	| "Programs";

type Click = (el: Element | null | undefined) => Promise<void>;

function byText(root: ParentNode, selector: string, text: string): Element | undefined {
	return [...root.querySelectorAll(selector)].find((el) => el.textContent === text);
}

export async function openDesktopPage(root: ParentNode, click: Click, page: DesktopPage): Promise<void> {
	if (page === "Settings" || page === "Projects" || page === "Archive") {
		await click(root.querySelector('nav[aria-label="Sidebar"] button[aria-label="You"]'));
		await click(byText(root, '[role="menuitem"]', page));
		return;
	}
	if (page === "Notes" || page === "Delegations" || page === "Programs") {
		const tab = page === "Notes" ? "Library" : page === "Programs" ? "Scheduled" : "Activity";
		const footer = page === "Notes" ? "All notes" : page === "Programs" ? "All programs" : "All delegations";
		await click(byText(root, '.goblin-column [role="tab"]', tab));
		await click(byText(root, ".goblin-column button.goblin-panel-footer", footer));
		return;
	}
	const href = page === "Status" ? "/app/status" : "/app/memory";
	const profile = 'nav[aria-label="Goblin\'s profile"]';
	if (root.querySelector(profile) === null) {
		await click(root.querySelector(".goblin-column .goblin-profile-button"));
		if (page === "Status") return;
	}
	await click(root.querySelector(`${profile} a[href="${href}"]`));
}
