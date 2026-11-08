// Programs page (#183): a table with the schedule in words and a status that
// shows lateness, a summary strip, and a detail that replaces the list.
// happy-dom mount, fetch faked at globalThis.fetch.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppApprovalsResponse } from "../../src/http/app-wire.ts";
import type { OperatorProgramItem } from "../../src/http/operator-wire.ts";
import { ProgramsView, programStatus, triggerWords } from "./ProgramsView.tsx";

const NOW = Date.parse("2026-11-07T12:00:00Z");

function program(over: Partial<OperatorProgramItem>): OperatorProgramItem {
	return {
		id: 1,
		name: "Morning digest",
		charter: "Summarise the feed.\nSkip repeats.",
		cron: "0 7 * * *",
		maxLatenessMinutes: 30,
		hasHook: false,
		mailFilter: null,
		enabled: true,
		target: "dm:1",
		chatId: 1,
		threadId: null,
		createdAt: "2026-10-01T00:00:00Z",
		lastRun: "2026-11-07T07:00:00Z",
		nextRun: "2026-11-08T07:00:00Z",
		...over,
	};
}

test("status: disabled wins, a past-due next run is late, otherwise enabled", () => {
	expect(programStatus(program({ enabled: false }), NOW)).toEqual({ kind: "disabled" });
	expect(programStatus(program({ nextRun: "2026-11-07T11:46:00Z" }), NOW)).toEqual({
		kind: "late",
		minutes: 14,
	});
	// inside the scheduler's scan slack: not late yet
	expect(programStatus(program({ nextRun: "2026-11-07T11:59:00Z" }), NOW).kind).toBe("enabled");
	expect(programStatus(program({ cron: null, nextRun: null }), NOW).kind).toBe("enabled");
});

test("trigger words: cron in words, raw cron when not covered, else how it starts", () => {
	expect(triggerWords(program({}))).toBe("Daily 07:00");
	expect(triggerWords(program({ cron: "7 3 5 2 *" }))).toBe("7 3 5 2 *");
	expect(triggerWords(program({ cron: null, hasHook: true }))).toBe("Webhook");
	expect(triggerWords(program({ cron: null, mailFilter: "from:a" }))).toBe("On new mail");
	expect(triggerWords(program({ cron: null }))).toBe("Manual");
});

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

function fakeServer(
	programs: OperatorProgramItem[],
	approvals: AppApprovalsResponse,
	serverTimeZone = "America/Mexico_City",
) {
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			if (url.pathname === "/api/app/programs")
				return Response.json({ programs, serverTimeZone });
			if (url.pathname === "/api/app/approvals") return Response.json(approvals);
			throw new Error(`unexpected request: ${url.pathname}`);
		},
		{ preconnect: realFetch.preconnect },
	);
}

test("the list is a table; opening a row replaces it with the detail and a back link", async () => {
	fakeServer(
		[
			program({ id: 1 }),
			program({ id: 2, name: "Link scan", cron: "0 21 * * *", nextRun: "2000-01-01T00:00:00Z" }),
			program({ id: 3, name: "Old invoice sweep", enabled: false }),
		],
		{
			programs: [],
			mail: [
				{
					id: 5,
					to: ["a@example.com"],
					cc: [],
					subject: "Hello",
					body: "Body text",
					replyToId: null,
					target: "dm:1",
					status: "pending",
					createdAt: "2026-11-07T00:00:00Z",
					expiresAt: "2026-11-08T00:00:00Z",
					decidedAt: null,
					decidedBy: null,
					sentId: null,
				},
			],
		},
	);
	root = createRoot(container);
	await act(async () => root?.render(<ProgramsView token={null} now={NOW} />));

	const rows = [...container.querySelectorAll(".dtable .dt-row")];
	expect(rows.map((r) => r.querySelector(".dt-main")?.textContent)).toEqual([
		"Morning digest",
		"Link scan",
		"Old invoice sweep",
	]);
	expect(rows[0]?.textContent).toContain("Daily 07:00");
	expect(rows[1]?.querySelector(".pill.warn")?.textContent).toMatch(/^late \d+ min$/);
	expect(rows[2]?.querySelector(".pill")?.textContent).toBe("disabled");
	// the mail approval still renders with its Send button
	expect(container.textContent).toContain("Mail draft #5");
	const tiles = [...container.querySelectorAll(".sumtile")].map((t) => t.textContent);
	expect(tiles).toEqual(["1awaiting approval", "2/3enabled", "1late"]);

	await act(async () => (rows[0] as HTMLElement).click());
	expect(container.querySelector(".dtable")).toBeNull();
	expect(container.querySelector(".prog-charter")?.textContent).toBe(
		"Summarise the feed.\nSkip repeats.",
	);
	const back = [...container.querySelectorAll("button")].find(
		(b) => b.textContent === "‹ Programs",
	);
	expect(back).toBeDefined();
	await act(async () => (back as HTMLElement).click());
	expect(container.querySelector(".dtable")).not.toBeNull();
});

test("schedule and run times share the server's zone (#187)", async () => {
	// A cron at 07:00 server time with the server on UTC: the words, the zone
	// label and the run columns must all say the same clock — before the fix
	// the runs rendered in the browser's zone and disagreed by hours.
	fakeServer([program({})], { programs: [], mail: [] }, "UTC");
	root = createRoot(container);
	await act(async () => root?.render(<ProgramsView token={null} now={NOW} />));

	const row = container.querySelector(".dtable .dt-row");
	expect(row?.textContent).toContain("Daily 07:00 UTC");
	expect(row?.querySelector('[data-label="Next run"]')?.textContent).toContain("07:00");
	expect(row?.querySelector('[data-label="Last run"]')?.textContent).toContain("07:00");
});
