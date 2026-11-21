import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	afterUserScroll,
	endTurnFollow,
	followTarget,
	REPLY_HEAD_GAP_PX,
	replyHead,
	repliesAfter,
} from "./useTranscriptFollow.ts";

let win: Window;

beforeEach(() => {
	win = new Window();
});

afterEach(async () => {
	await win.happyDOM.close();
});

type Layout = {
	scrollHeight: number;
	clientHeight: number;
	scrollTop: number;
	headTop?: number;
	oldHeadTop?: number;
};

function transcript(rows: string, layout: Layout): Element {
	const scroller = win.document.createElement("div");
	scroller.innerHTML = `<div class="transcript-inner">${rows}</div>`;
	win.document.body.appendChild(scroller);
	Object.defineProperty(scroller, "scrollHeight", { value: layout.scrollHeight });
	Object.defineProperty(scroller, "clientHeight", { value: layout.clientHeight });
	Object.defineProperty(scroller, "scrollTop", { value: layout.scrollTop });
	Object.defineProperty(scroller, "getBoundingClientRect", { value: () => ({ top: 0 }) });
	for (const [id, headTop] of [
		["reply", layout.headTop],
		["old", layout.oldHeadTop],
	] as const) {
		const row = scroller.querySelector(`#${id}`);
		if (row !== null && headTop !== undefined) {
			const top = headTop - layout.scrollTop;
			Object.defineProperty(row, "getBoundingClientRect", { value: () => ({ top }) });
		}
	}
	return scroller as unknown as Element;
}

const asked = `<div class="msg user" data-outline-anchor="u1">question</div>`;
const reply = `<div class="msg assistant" id="reply">answer</div>`;
const oldReply = `<div class="msg assistant" id="old">old answer</div>`;
const shimmer = `<div class="msg assistant pending shimmer">…</div>`;

describe("replyHead", () => {
	test("finds the reply after the asked message, past the pending shimmer", () => {
		const el = transcript(`${asked}${shimmer}${reply}`, { scrollHeight: 0, clientHeight: 0, scrollTop: 0 });
		expect(replyHead(el, "u1")?.id).toBe("reply");
	});

	test("an older reply above the asked message is never the head", () => {
		const el = transcript(`${reply}${asked}${shimmer}`, { scrollHeight: 0, clientHeight: 0, scrollTop: 0 });
		expect(replyHead(el, "u1")).toBeNull();
	});

	test("the next user message ends the search", () => {
		const el = transcript(
			`${asked}<div class="msg user" data-outline-anchor="u2">next</div>${reply}`,
			{ scrollHeight: 0, clientHeight: 0, scrollTop: 0 },
		);
		expect(replyHead(el, "u1")).toBeNull();
	});
});

describe("followTarget", () => {
	test("tail follows the end", () => {
		const el = transcript(asked, { scrollHeight: 2000, clientHeight: 800, scrollTop: 900 });
		expect(followTarget(el, { kind: "tail" })).toEqual({
			top: 1200,
			next: { kind: "tail" },
		});
	});

	test("free never scrolls", () => {
		const el = transcript(asked, { scrollHeight: 2000, clientHeight: 800, scrollTop: 900 });
		expect(followTarget(el, { kind: "free" })).toBeNull();
	});

	test("before the reply starts, a sent message follows the end", () => {
		const el = transcript(`${asked}${shimmer}`, { scrollHeight: 2000, clientHeight: 800, scrollTop: 900 });
		const follow = { kind: "reply", after: "u1", stale: new Set<Element>() } as const;
		expect(followTarget(el, follow)).toEqual({ top: 1200, next: follow });
	});

	test("a retry follows the new reply, not the one it replaces", () => {
		const el = transcript(`${asked}${oldReply}`, {
			scrollHeight: 3000,
			clientHeight: 800,
			scrollTop: 1100,
			oldHeadTop: 1500,
		});
		const old = el.querySelector("#old");
		expect(old).not.toBeNull();
		const follow = { kind: "reply", after: "u1", stale: new Set([old!]) } as const;
		const target = followTarget(el, follow);
		expect(target?.top).toBe(2200);
		expect(target?.next).toBe(follow);
	});

	test("a reply that fits keeps following the end", () => {
		const el = transcript(`${asked}${reply}`, {
			scrollHeight: 2000,
			clientHeight: 800,
			scrollTop: 1100,
			headTop: 1500,
		});
		const follow = { kind: "reply", after: "u1", stale: new Set<Element>() } as const;
		expect(followTarget(el, follow)).toEqual({ top: 1200, next: follow });
	});

	test("a reply taller than the view holds with its head at the top, then stops following", () => {
		const el = transcript(`${asked}${reply}`, {
			scrollHeight: 3000,
			clientHeight: 800,
			scrollTop: 1100,
			headTop: 1500,
		});
		expect(
			followTarget(el, { kind: "reply", after: "u1", stale: new Set<Element>() }),
		).toEqual({ top: 1500 - REPLY_HEAD_GAP_PX, next: { kind: "free" } });
	});

	test("a retry holds the new reply, not the one it replaces", () => {
		const el = transcript(`${asked}${oldReply}${reply}`, {
			scrollHeight: 3000,
			clientHeight: 800,
			scrollTop: 1100,
			headTop: 1500,
			oldHeadTop: 1300,
		});
		const old = el.querySelector("#old");
		expect(old).not.toBeNull();
		const follow = { kind: "reply", after: "u1", stale: new Set([old!]) } as const;
		expect(followTarget(el, follow)).toEqual({
			top: 1500 - REPLY_HEAD_GAP_PX,
			next: { kind: "free" },
		});
	});
});

describe("endTurnFollow", () => {
	test("a finished short reply switches to tail before a remote turn", () => {
		const el = transcript(`${asked}${reply}`, {
			scrollHeight: 2000,
			clientHeight: 800,
			scrollTop: 1200,
			headTop: 1500,
		});
		const following = { kind: "reply", after: "u1", stale: new Set<Element>() } as const;
		expect(followTarget(el, following)?.next).toBe(following);
		const next = endTurnFollow(el, following);
		expect(next).toEqual({ kind: "tail" });
		const remote = transcript(
			`${asked}${reply}<div class="msg user" data-outline-anchor="u2">remote</div>${reply}`,
			{ scrollHeight: 2200, clientHeight: 800, scrollTop: 1200, headTop: 2100 },
		);
		expect(followTarget(remote, next)?.top).toBe(1400);
	});

	test("no reply head, free, and tail modes are unchanged", () => {
		const noHead = transcript(`${asked}${shimmer}`, {
			scrollHeight: 2000,
			clientHeight: 800,
			scrollTop: 1200,
		});
		const waiting = { kind: "reply", after: "u1", stale: new Set<Element>() } as const;
		expect(endTurnFollow(noHead, waiting)).toBe(waiting);
		const el = transcript(`${asked}${reply}`, {
			scrollHeight: 2000,
			clientHeight: 800,
			scrollTop: 1200,
			headTop: 1500,
		});
		const free = { kind: "free" } as const;
		const tail = { kind: "tail" } as const;
		expect(endTurnFollow(el, free)).toBe(free);
		expect(endTurnFollow(el, tail)).toBe(tail);
	});
});

describe("repliesAfter", () => {
	test("returns replies after the asked message through the next user, excluding pending rows", () => {
		const nextUser = `<div class="msg user" data-outline-anchor="u2">next</div>`;
		const el = transcript(`${asked}${oldReply}${shimmer}${reply}${nextUser}${oldReply}`, {
			scrollHeight: 0,
			clientHeight: 0,
			scrollTop: 0,
		});
		expect([...repliesAfter(el, "u1")].map((row) => row.id)).toEqual(["old", "reply"]);
	});

	test("returns an empty set when the asked message is not mounted", () => {
		const el = transcript(`${oldReply}${reply}`, {
			scrollHeight: 0,
			clientHeight: 0,
			scrollTop: 0,
		});
		expect(repliesAfter(el, "missing").size).toBe(0);
	});
});

describe("afterUserScroll", () => {
	const reply = { kind: "reply", after: "u1", stale: new Set<Element>() } as const;

	test("a clamp at the end while following a reply keeps the reply", () => {
		const move = { from: 4487, to: 4474, atEnd: true };
		expect(afterUserScroll(reply, move)).toBe(reply);
		expect(afterUserScroll({ kind: "tail" }, move)).toEqual({ kind: "tail" });
	});

	test("reaching the end by hand follows the tail again", () => {
		expect(afterUserScroll({ kind: "free" }, { from: 900, to: 1200, atEnd: true })).toEqual({
			kind: "tail",
		});
	});

	test("any upward scroll the app did not make lets go", () => {
		expect(afterUserScroll({ kind: "tail" }, { from: 1200, to: 1100, atEnd: false })).toEqual({
			kind: "free",
		});
		expect(afterUserScroll(reply, { from: 1200, to: 1100, atEnd: false })).toEqual({
			kind: "free",
		});
	});

	test("a downward scroll short of the end keeps the mode", () => {
		expect(afterUserScroll(reply, { from: 900, to: 1000, atEnd: false })).toBe(reply);
		expect(afterUserScroll({ kind: "free" }, { from: 900, to: 1000, atEnd: false })).toEqual({
			kind: "free",
		});
	});
});
