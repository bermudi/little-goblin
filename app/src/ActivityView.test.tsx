import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { AppPost, AppPostsResponse } from "../../src/http/app-wire.ts";
import { ActivityView } from "./ActivityView.tsx";

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
const old: Array<[string, PropertyDescriptor | undefined]> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
	win = new Window({ url: "http://localhost/app/activity" });
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
	for (const [key, value] of [["window", win], ["document", win.document], ["navigator", win.navigator], ["IS_REACT_ACT_ENVIRONMENT", true]] as const) {
		old.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
		Reflect.set(globalThis, key, value);
	}
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	globalThis.fetch = realFetch;
	await win.happyDOM.close();
	for (const [key, descriptor] of old.splice(0)) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
		else Object.defineProperty(globalThis, key, descriptor);
	}
});

const minute = (n: number) => new Date(Date.UTC(2026, 10, 21, 0, n)).toISOString();
const post = (id: number): AppPost => ({ id, text: `Post ${id}`, createdAt: minute(id), conversation: null });

test("the activity page pages through older posts and keeps finished work in time order", async () => {
	const kept = Array.from({ length: 5 }, (_, i) => post(5 - i));
	const requests: string[] = [];
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
		const url = String(input);
		requests.push(url);
		const before = Number(new URL(url, "http://localhost").searchParams.get("before") ?? Infinity);
		const older = kept.filter((p) => p.id < before);
		return Response.json({ posts: older.slice(0, 2), more: older.length > 2 } satisfies AppPostsResponse);
	}, { preconnect: realFetch.preconnect });
	const data = {
		attention: [], attentionError: false, programs: [], loadError: false, working: 1, reload() {},
		activity: { busy: [], otherBusy: 0, posts: [post(6)] },
		delegations: [
			{ id: 1, name: "still-going", harness: "codex", task: "Still going", status: "running", createdAt: minute(0), appConversation: null },
			{ id: 2, name: "old-task", harness: "pi", task: "Old task", status: "done", createdAt: minute(0), finishedAt: new Date(Date.UTC(2026, 10, 21, 0, 1, 30)).toISOString(), appConversation: null },
		],
	} as unknown as Parameters<typeof ActivityView>[0]["data"];
	root = createRoot(container);
	await act(async () => root?.render(<ActivityView token={null} data={data} onOpenConversation={() => {}} onOpenPage={() => {}} />));
	const labels = () => [...container.querySelectorAll(".goblin-panel-row strong")].map((el) => el.textContent);
	const older = () => [...container.querySelectorAll("button")].find((el) => el.textContent === "Show older");
	expect(labels()).toEqual(["still-going", "Post 6", "Post 5", "Post 4"]);
	await act(async () => older()?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
	expect(labels()).toEqual(["still-going", "Post 6", "Post 5", "Post 4", "Post 3", "Post 2"]);
	await act(async () => older()?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
	expect(labels()).toEqual(["still-going", "Post 6", "Post 5", "Post 4", "Post 3", "Post 2", "old-task", "Post 1"]);
	expect(container.textContent).not.toContain("Still going");
	expect(container.textContent).not.toContain("Old task");
	expect(older()).toBeUndefined();
	expect(requests).toEqual(["/api/app/posts", "/api/app/posts?before=4", "/api/app/posts?before=2"]);
});

test("the activity page keeps posts that leave the live poll and fills a gap the poll skipped", async () => {
	const kept = Array.from({ length: 5 }, (_, i) => post(5 - i));
	const requests: string[] = [];
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
		const url = String(input);
		requests.push(url);
		const before = Number(new URL(url, "http://localhost").searchParams.get("before") ?? Infinity);
		const older = kept.filter((p) => p.id < before);
		return Response.json({ posts: older.slice(0, 2), more: older.length > 2 } satisfies AppPostsResponse);
	}, { preconnect: realFetch.preconnect });
	const view = (posts: AppPost[]) => {
		const data = {
			attention: [], attentionError: false, programs: [], loadError: false, working: 0, reload() {},
			activity: { busy: [], otherBusy: 0, posts }, delegations: [],
		} as unknown as Parameters<typeof ActivityView>[0]["data"];
		return <ActivityView token={null} data={data} onOpenConversation={() => {}} onOpenPage={() => {}} />;
	};
	const labels = () => [...container.querySelectorAll(".goblin-panel-row strong")].map((el) => el.textContent);
	const arrive = async (...ids: number[]) => {
		kept.unshift(...ids.map(post));
		const polled = kept.slice(0, 2);
		await act(async () => root?.render(view(polled)));
	};
	root = createRoot(container);
	await act(async () => root?.render(view([])));
	expect(labels()).toEqual(["Post 5", "Post 4"]);
	await arrive(7, 6);
	await arrive(9, 8);
	expect(labels()).toEqual(["Post 9", "Post 8", "Post 7", "Post 6", "Post 5", "Post 4"]);
	await arrive(13, 12, 11, 10);
	expect(labels()).toEqual(["Post 13", "Post 12", "Post 11", "Post 10", "Post 9", "Post 8", "Post 7", "Post 6", "Post 5", "Post 4"]);
	expect(requests).toEqual(["/api/app/posts", "/api/app/posts?before=12"]);
});
