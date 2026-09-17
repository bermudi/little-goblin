import { describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import type { Conversation } from "../conversation.ts";
import { makeDeliverySink } from "./delivery.ts";

const CHUNK = 3800;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const conv: Conversation = {
	id: "dm:1",
	chatId: 1,
	threadId: null,
	title: null,
	cwd: "/w",
	model: null,
	thinking: null,
	epoch: 0,
	createdAt: "",
};

// Fake the Telegram API at the edge. `gate` holds sends while set.
function fakeApi(opts: { gate?: { current: Promise<void> | null }; failSends?: boolean }) {
	const msgs: string[] = [];
	const api = {
		sendChatAction: () => Promise.resolve(true),
		sendMessage: async (_chat: number, text: string) => {
			if (opts.gate?.current) await opts.gate.current;
			if (opts.failSends) throw new Error("sendMessage failed");
			msgs.push(text);
			return { message_id: msgs.length };
		},
		editMessageText: async (_chat: number, id: number, text: string) => {
			msgs[id - 1] = text;
			return true;
		},
	} as unknown as Api;
	return { api, msgs };
}

describe("delivery", () => {
	test("short reply → one message, edited in place", async () => {
		const { api, msgs } = fakeApi({});
		const sink = makeDeliverySink(api, conv, undefined, 0);
		sink.onTextDelta("hello");
		await sleep(0);
		sink.onTextDelta(" world");
		await sink.onDone({ kind: "completed" });
		expect(msgs).toEqual(["hello world"]);
	});

	test("a chunk sent early is patched when its window fills — nothing dropped", async () => {
		const gate: { current: Promise<void> | null } = { current: null };
		const { api, msgs } = fakeApi({ gate });
		const sink = makeDeliverySink(api, conv, undefined, 0);

		sink.onTextDelta("a".repeat(CHUNK)); // → send msg1
		await sleep(0);
		expect(msgs).toEqual(["a".repeat(CHUNK)]);

		// msg2 sends with a partial window; hold it in flight.
		let release: () => void = () => {};
		gate.current = new Promise<void>((r) => {
			release = r;
		});
		sink.onTextDelta("b".repeat(100));
		await sleep(0);
		expect(msgs.length).toBe(1); // msg2 send still in flight

		// Output grows past the boundary while msg2 is in flight.
		sink.onTextDelta("b".repeat(CHUNK));
		gate.current = null;
		release();
		await sink.onDone({ kind: "completed" });

		// msg2 must be patched to its full window, not left short —
		// otherwise the slice between what it showed and the boundary is
		// dropped silently.
		expect(msgs).toEqual([
			"a".repeat(CHUNK),
			"b".repeat(CHUNK),
			"b".repeat(100),
		]);
	});

	test("failed send at final flush is retried, not dropped", async () => {
		let calls = 0;
		const msgs: string[] = [];
		const api = {
			sendChatAction: () => Promise.resolve(true),
			sendMessage: async (_chat: number, text: string) => {
				calls++;
				if (calls === 1) throw new Error("transient failure");
				msgs.push(text);
				return { message_id: msgs.length };
			},
			editMessageText: () => Promise.resolve(true),
		} as unknown as Api;
		const sink = makeDeliverySink(api, conv, undefined, 0);
		sink.onTextDelta("tail");
		// First send fails inside onDone's flush; the drain retries it.
		await sink.onDone({ kind: "completed" });
		expect(msgs).toEqual(["tail"]);
	});

	test("permanently failing sends don't make onDone throw", async () => {
		const { api } = fakeApi({ failSends: true });
		const sink = makeDeliverySink(api, conv, undefined, 0);
		sink.onTextDelta("lost");
		await expect(sink.onDone({ kind: "completed" })).resolves.toBeUndefined();
	});
});
