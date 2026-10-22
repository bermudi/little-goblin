// Approval decisions: a granted hook URL is revealed once and never
// refetchable, so the refresh that drops the settled card must wait for
// the operator's dismiss — a card that unmounts on the response takes
// the only copy of the URL with it. happy-dom mount, fetch faked at
// globalThis.fetch.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { ApprovalsPanel } from "./Approvals.tsx";
import type { AppProgramProposal } from "../../src/http/app-wire.ts";

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
const realFetch = globalThis.fetch;
const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	win = new Window({ url: "http://localhost/app" });
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
	for (const [name, value] of [
		["window", win],
		["document", win.document],
		["navigator", win.navigator],
		["IS_REACT_ACT_ENVIRONMENT", true],
	] as const) {
		globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Reflect.set(globalThis, name, value);
	}
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	await win.happyDOM.close();
	globalThis.fetch = realFetch;
	for (const [name, descriptor] of globals) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
		else Object.defineProperty(globalThis, name, descriptor);
	}
	globals.clear();
});

const PROPOSAL: AppProgramProposal = {
	id: 7,
	kind: "create",
	targetId: null,
	target: "ops",
	state: "pending",
	createdAt: "2026-10-22T00:00:00Z",
	decidedAt: null,
	decidedBy: null,
	activatedId: null,
	candidate: {
		name: "nightly",
		charter: "do the thing",
		cron: "0 3 * * *",
		maxLatenessMinutes: null,
		hook: true,
		mailFilter: null,
	},
};

const cardButton = (label: string) =>
	[...container.querySelectorAll(".approval-card button")].find((el) => el.textContent === label) as
		| HTMLButtonElement
		| undefined;

test("a granted hook URL stays on screen until the operator dismisses it", async () => {
	let lists = 0;
	let decided = false;
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			if (url.pathname === "/api/app/approvals") {
				lists++;
				return Response.json({ programs: decided ? [] : [PROPOSAL], mail: [] });
			}
			if (url.pathname === "/api/app/approvals/program/7" && init?.method === "POST") {
				decided = true;
				return Response.json({
					status: "activated",
					message: "Program activated.",
					hookUrl: "https://goblin.example/hooks/once",
				});
			}
			throw new Error(`unexpected request: ${url.pathname}`);
		},
		{ preconnect: realFetch.preconnect },
	);
	root = createRoot(container);
	await act(async () => root?.render(<ApprovalsPanel token={null} />));
	const approve = cardButton("Approve");
	expect(approve).toBeDefined();
	await act(async () => approve?.click());
	// The settle is in, but the card holds: the reveal is the only copy
	// of the URL, so the refetch that would drop the row waits — the
	// panel still reads from the pre-decision list.
	expect(container.querySelector(".secret-reveal pre")?.textContent).toBe(
		"https://goblin.example/hooks/once",
	);
	expect(container.querySelector(".approval-card")).not.toBeNull();
	expect(lists).toBe(1);
	// A settled card's decide buttons are dead — a second click would
	// fire the deferred refresh and take the URL with it.
	expect(cardButton("Approve")?.hasAttribute("disabled")).toBe(true);
	const done = cardButton("Done");
	expect(done).toBeDefined();
	await act(async () => done?.click());
	expect(lists).toBe(2);
	expect(container.querySelector(".approval-card")).toBeNull();
	expect(container.textContent).toContain("No pending approvals.");
});

test("a decision without a hook URL refreshes immediately", async () => {
	let lists = 0;
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			if (url.pathname === "/api/app/approvals") {
				lists++;
				return Response.json({ programs: lists === 1 ? [PROPOSAL] : [], mail: [] });
			}
			if (url.pathname === "/api/app/approvals/program/7" && init?.method === "POST") {
				return Response.json({ status: "rejected", message: "Proposal rejected." });
			}
			throw new Error(`unexpected request: ${url.pathname}`);
		},
		{ preconnect: realFetch.preconnect },
	);
	root = createRoot(container);
	await act(async () => root?.render(<ApprovalsPanel token={null} />));
	const reject = cardButton("Reject");
	expect(reject).toBeDefined();
	await act(async () => reject?.click());
	// Nothing one-time to protect — the row drops on the response.
	expect(lists).toBe(2);
	expect(container.querySelector(".approval-card")).toBeNull();
});
