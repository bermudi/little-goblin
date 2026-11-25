import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	afterUserScroll,
	endTurnFollow,
	followTarget,
	initialFollow,
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
const pending = `<div class="msg assistant pending"></div>`;

describe("replyHead", () => {
	test("finds the reply after the asked message, past the pending card", () => {
		const el = transcript(`${asked}${pending}${reply}`, { scrollHeight: 0, clientHeight: 0, scrollTop: 0 });
		expect(replyHead(el, "u1")?.id).toBe("reply");
	});

	test("an older reply above the asked message is never the head", () => {
		const el = transcript(`${reply}${asked}${pending}`, { scrollHeight: 0, clientHeight: 0, scrollTop: 0 });
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
	test("initialFollow arms reply-head follow only when given a message id", () => {
		expect(initialFollow()).toEqual({ kind: "tail" });
		const follow = initialFollow("u1");
		expect(follow.kind).toBe("reply");
		if (follow.kind !== "reply") return;
		expect(follow.after).toBe("u1");
		expect(follow.stale.size).toBe(0);
		const long = transcript(`${asked}<div class="msg assistant" id="reply">answer</div>`, {
			scrollHeight: 3000,
			clientHeight: 800,
			scrollTop: 1100,
			headTop: 1500,
		});
		expect(followTarget(long, follow)).toEqual({
			top: 1500 - REPLY_HEAD_GAP_PX,
			next: { kind: "free" },
		});
		expect(followTarget(long, initialFollow())?.top).toBe(2200);
	});

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
		const el = transcript(`${asked}${pending}`, { scrollHeight: 2000, clientHeight: 800, scrollTop: 900 });
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
	test("remembers turn end until a short reply mounts, then follows later turns at the end", () => {
		const following = { kind: "reply", after: "u1", stale: new Set<Element>() } as const;
		const waiting = transcript(`${asked}${pending}`, {
			scrollHeight: 2000,
			clientHeight: 800,
			scrollTop: 1200,
		});
		const ended = endTurnFollow(following);
		expect(ended).toEqual({ ...following, ended: true });
		expect(followTarget(waiting, ended)?.next).toBe(ended);
		const shortReply = transcript(`${asked}${reply}`, {
			scrollHeight: 2000,
			clientHeight: 800,
			scrollTop: 1200,
			headTop: 1500,
		});
		const resolved = followTarget(shortReply, ended);
		expect(resolved).toEqual({ top: 1200, next: { kind: "tail" } });
		const remote = transcript(
			`${asked}${reply}<div class="msg user" data-outline-anchor="u2">remote</div>${reply}`,
			{ scrollHeight: 3000, clientHeight: 800, scrollTop: 1200, headTop: 2500 },
		);
		expect(followTarget(remote, resolved!.next)?.top).toBe(2200);
	});

	test("a long reply mounting after turn-end still holds its head", () => {
		const following = { kind: "reply", after: "u1", stale: new Set<Element>() } as const;
		const ended = endTurnFollow(following);
		const el = transcript(`${asked}${reply}`, {
			scrollHeight: 3000,
			clientHeight: 800,
			scrollTop: 1100,
			headTop: 1500,
		});
		expect(followTarget(el, ended)).toEqual({
			top: 1500 - REPLY_HEAD_GAP_PX,
			next: { kind: "free" },
		});
	});

	test("a remote queued turn follows the tail instead of the previous reply head", () => {
		const following = { kind: "reply", after: "u1", stale: new Set<Element>() } as const;
		const shortReply = transcript(`${asked}${reply}`, {
			scrollHeight: 2000,
			clientHeight: 800,
			scrollTop: 1200,
			headTop: 1500,
		});
		const ended = endTurnFollow(following);
		const resolved = followTarget(shortReply, ended);
		expect(resolved).toEqual({ top: 1200, next: { kind: "tail" } });
		const remote = transcript(
			`${asked}${reply}<div class="msg user" data-outline-anchor="u2">remote</div><div class="msg assistant" id="remote">growing reply</div>`,
			{ scrollHeight: 3800, clientHeight: 800, scrollTop: 1200, headTop: 1500 },
		);
		const remoteTarget = followTarget(remote, resolved!.next);
		expect(remoteTarget?.top).toBe(3000);
		expect(remoteTarget?.next).toEqual({ kind: "tail" });
		expect(followTarget(remote, remoteTarget!.next)?.top).toBe(3000);
	});

	test("non-reply modes are unchanged; an open short reply stays armed", () => {
		const following = { kind: "reply", after: "u1", stale: new Set<Element>() } as const;
		const free = { kind: "free" } as const;
		const tail = { kind: "tail" } as const;
		expect(endTurnFollow(free)).toBe(free);
		expect(endTurnFollow(tail)).toBe(tail);
		const el = transcript(`${asked}${reply}`, {
			scrollHeight: 2000,
			clientHeight: 800,
			scrollTop: 1200,
			headTop: 1500,
		});
		expect(followTarget(el, following)?.next).toBe(following);
	});
});

describe("repliesAfter", () => {
	test("returns replies after the asked message through the next user, excluding pending rows", () => {
		const nextUser = `<div class="msg user" data-outline-anchor="u2">next</div>`;
		const el = transcript(`${asked}${oldReply}${pending}${reply}${nextUser}${oldReply}`, {
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
