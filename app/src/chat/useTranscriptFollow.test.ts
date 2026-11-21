import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	afterUserScroll,
	followTarget,
	REPLY_HEAD_GAP_PX,
	replyHead,
} from "./useTranscriptFollow.ts";

let win: Window;

beforeEach(() => {
	win = new Window();
});

afterEach(async () => {
	await win.happyDOM.close();
});

type Layout = { scrollHeight: number; clientHeight: number; scrollTop: number; headTop?: number };

function transcript(rows: string, layout: Layout): Element {
	const scroller = win.document.createElement("div");
	scroller.innerHTML = `<div class="transcript-inner">${rows}</div>`;
	win.document.body.appendChild(scroller);
	Object.defineProperty(scroller, "scrollHeight", { value: layout.scrollHeight });
	Object.defineProperty(scroller, "clientHeight", { value: layout.clientHeight });
	Object.defineProperty(scroller, "scrollTop", { value: layout.scrollTop });
	Object.defineProperty(scroller, "getBoundingClientRect", { value: () => ({ top: 0 }) });
	const reply = scroller.querySelector("#reply");
	if (reply !== null && layout.headTop !== undefined) {
		const top = layout.headTop - layout.scrollTop;
		Object.defineProperty(reply, "getBoundingClientRect", { value: () => ({ top }) });
	}
	return scroller as unknown as Element;
}

const asked = `<div class="msg user" data-outline-anchor="u1">question</div>`;
const reply = `<div class="msg assistant" id="reply">answer</div>`;
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
		const follow = { kind: "reply", after: "u1" } as const;
		expect(followTarget(el, follow)).toEqual({ top: 1200, next: follow });
	});

	test("a reply that fits keeps following the end", () => {
		const el = transcript(`${asked}${reply}`, {
			scrollHeight: 2000,
			clientHeight: 800,
			scrollTop: 1100,
			headTop: 1500,
		});
		const follow = { kind: "reply", after: "u1" } as const;
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
			followTarget(el, { kind: "reply", after: "u1" }),
		).toEqual({ top: 1500 - REPLY_HEAD_GAP_PX, next: { kind: "free" } });
	});
});

describe("afterUserScroll", () => {
	const reply = { kind: "reply", after: "u1" } as const;

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
