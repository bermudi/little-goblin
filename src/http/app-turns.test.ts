import { describe, expect, jest, test } from "bun:test";
import { waitUntil } from "../testkit.ts";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";

interface EventReader {
	read(): Promise<{ value?: Uint8Array; done: boolean }>;
	cancel(): Promise<void>;
}

async function nextEvent(reader: EventReader): Promise<unknown> {
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) throw new Error("event stream closed before the expected event");
		buffer += decoder.decode(value, { stream: true });
		const end = buffer.indexOf("\n\n");
		if (end === -1) continue;
		const frame = buffer.slice(0, end);
		buffer = buffer.slice(end + 2);
		const data = frame.split("\n").find((line) => line.startsWith("data: "));
		if (data !== undefined) return JSON.parse(data.slice(6)) as unknown;
	}
}

describe("app conversation events", () => {
	test("sends keepalives while an event stream is idle", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "events-keepalive" }),
			});
			jest.useFakeTimers();
			const response = await call("/api/app/conversations/events-keepalive/events");
			const reader = response.body!.getReader();
			expect(await nextEvent(reader as unknown as EventReader)).toEqual({ type: "state", live: false });
			jest.advanceTimersByTime(25_000);
			expect(new TextDecoder().decode((await reader.read()).value)).toBe(": keepalive\n\n");
			await reader.cancel();
		} finally {
			jest.useRealTimers();
			http.stop();
		}
	});

	test("idle state, authentication, unknown conversation and abort unsubscribe", async () => {
		const { http, call, runtime } = setup({ token: APP_TOKEN_NAME });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "events-idle" }),
			});
			expect((await call("/api/app/conversations/missing/events")).status).toBe(404);
			expect((await call("/api/app/conversations/events-idle/events", {}, null)).status).toBe(401);
			expect((await call("/api/app/conversations/missing/pending")).status).toBe(404);
			expect((await call("/api/app/conversations/events-idle/pending", {}, null)).status).toBe(401);
			const response = await call("/api/app/conversations/events-idle/events");
			const reader = response.body!.getReader() as unknown as EventReader;
			expect(await nextEvent(reader)).toEqual({ type: "state", live: false });
			expect(runtime.conversationEventSubscriberCount("app/events-idle")).toBe(1);
			await reader.cancel();
			await waitUntil(
				() => runtime.conversationEventSubscriberCount("app/events-idle") === 0,
				"events listener detached",
			);
		} finally {
			http.stop();
		}
	});

	test("live state and turn-start / turn-end; history is durable before turn-end", async () => {
		const { http, call, runtime, store } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["one", "two", "three", "four"],
			delayMs: 30,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "events-live" }),
			});
			const subscribed = await call("/api/app/conversations/events-live/events");
			const eventsReader = subscribed.body!.getReader() as unknown as EventReader;
			expect(await nextEvent(eventsReader)).toEqual({ type: "state", live: false });
			const submitted = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/events-live",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(submitted.status).toBe(202);
			expect(await submitted.json()).toEqual({ submitted: true });
			expect(await nextEvent(eventsReader)).toEqual({ type: "turn-start", elapsedMs: expect.any(Number) });
			await waitUntil(() => runtime.conversationLive("app/events-live"), "live wire opens");
			await Bun.sleep(30);
			const response = await call("/api/app/conversations/events-live/events");
			const reader = response.body!.getReader() as unknown as EventReader;
			const state = await nextEvent(reader);
			expect(state).toEqual({ type: "state", live: true, elapsedMs: expect.any(Number) });
			expect((state as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(25);
			await reader.cancel();

			expect(await nextEvent(eventsReader)).toEqual({ type: "turn-end" });
			expect(store.history("app/events-live").map((message) => message.role)).toEqual([
				"user",
				"assistant",
			]);
			await eventsReader.cancel();
		} finally {
			http.stop();
		}
	});

	test("pending input is listed, announced, and can be removed before claim", async () => {
		const { http, call, runtime, store } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["one", "two", "three", "four", "five", "six"],
			delayMs: 50,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "pending-remove" }),
			});
			const events = await call("/api/app/conversations/pending-remove/events");
			const reader = events.body!.getReader() as unknown as EventReader;
			expect(await nextEvent(reader)).toEqual({ type: "state", live: false });
			await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/pending-remove",
					message: { id: "first", role: "user", parts: [{ type: "text", text: "first" }] },
				}),
			});
			await waitUntil(() => runtime.conversationLive("app/pending-remove"), "first wire opens");
			const submitted = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/pending-remove",
					whenBusy: "followUp",
					message: { id: "pending", role: "user", parts: [{ type: "text", text: "remove me" }] },
				}),
			});
			expect(submitted.status).toBe(202);
			const { pendingId } = (await submitted.json()) as { pendingId: string };
			expect(store.history("app/pending-remove").map((message) => message.id)).toEqual(["first"]);
			expect(await nextEvent(reader)).toEqual({ type: "turn-start", elapsedMs: expect.any(Number) });
			expect(await nextEvent(reader)).toEqual({ type: "pending" });
			const listed = await call("/api/app/conversations/pending-remove/pending");
			expect(await listed.json()).toMatchObject({
				items: [{ id: pendingId, mode: "followUp", message: { id: "pending" } }],
			});
			const removed = await call(
				`/api/app/conversations/pending-remove/pending/${pendingId}`,
				{ method: "DELETE" },
			);
			expect(removed.status).toBe(200);
			expect(await removed.json()).toMatchObject({ message: { id: "pending" } });
			expect(await nextEvent(reader)).toEqual({ type: "pending" });
			const afterRemove = (await call("/api/app/conversations/pending-remove/pending")).json() as Promise<{
				items: unknown[];
			}>;
			expect((await afterRemove).items).toEqual([]);
			await reader.cancel();
			await waitUntil(
				() => store.history("app/pending-remove").some((message) => message.role === "assistant"),
				"first reply completes",
			);
			expect(store.history("app/pending-remove").map((message) => message.id)).not.toContain("pending");
		} finally {
			http.stop();
		}
	});

	test("a claimed follow-up leaves the inbox and can no longer be deleted", async () => {
		const { http, call, runtime, store } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["one", "two", "three", "four"],
			delayMs: 10,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "pending-claim" }),
			});
			await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/pending-claim",
					message: { id: "first", role: "user", parts: [{ type: "text", text: "first" }] },
				}),
			});
			await waitUntil(() => runtime.conversationLive("app/pending-claim"), "first wire opens");
			const submitted = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/pending-claim",
					whenBusy: "followUp",
					message: { id: "pending", role: "user", parts: [{ type: "text", text: "run next" }] },
				}),
			});
			const { pendingId } = (await submitted.json()) as { pendingId: string };
			await waitUntil(
				() => store.history("app/pending-claim").some((message) => message.id === "pending"),
				"follow-up claimed into history",
			);
			expect(runtime.listPending("app/pending-claim")).toEqual([]);
			const refused = await call(
				`/api/app/conversations/pending-claim/pending/${pendingId}`,
				{ method: "DELETE" },
			);
			expect(refused.status).toBe(409);
			expect(await refused.json()).toEqual({ error: "already taken" });
		} finally {
			http.stop();
		}
	});

	test("/stop moves unclaimed pending input into history without running it", async () => {
		const { http, call, runtime, store } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["one", "two", "three", "four", "five", "six"],
			delayMs: 40,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "pending-stop" }),
			});
			await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/pending-stop",
					message: { id: "first", role: "user", parts: [{ type: "text", text: "first" }] },
				}),
			});
			await waitUntil(() => runtime.conversationLive("app/pending-stop"), "first wire opens");
			const submitted = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/pending-stop",
					message: { id: "pending", role: "user", parts: [{ type: "text", text: "keep this" }] },
				}),
			});
			expect(submitted.status).toBe(202);
			expect(runtime.listPending("app/pending-stop")).toHaveLength(1);
			const stopped = await call("/api/app/conversations/pending-stop/stop", { method: "POST" });
			expect(stopped.status).toBe(200);
			expect(runtime.listPending("app/pending-stop")).toEqual([]);
			expect(store.history("app/pending-stop").map((message) => message.id)).toContain("pending");
			expect(store.history("app/pending-stop").filter((message) => message.id === "pending")).toHaveLength(1);
			expect(store.history("app/pending-stop").filter((message) => message.role === "assistant")).toHaveLength(0);
		} finally {
			http.stop();
		}
	});
});

async function verifyAttachedReaderSurvivesSecondPost(delayMs: number): Promise<void> {
	const { http, call, runtime, store } = setup({
		token: APP_TOKEN_NAME,
		deltas: ["one", "two", "three", "four", "five", "six"],
		delayMs: 25,
	});
	try {
		await call("/api/app/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "reader-" + delayMs }),
		});
		const first = await call("/api/app/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				conversationId: `app/reader-${delayMs}`,
				message: { id: "m1", role: "user", parts: [{ type: "text", text: "first" }] },
			}),
		});
		expect(first.status).toBe(202);
		await waitUntil(() => runtime.conversationLive(`app/reader-${delayMs}`), "wire opens");
		const stream = await call(`/api/app/conversations/reader-${delayMs}/stream`);
		expect(stream.status).toBe(200);
		if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
		const second = await call("/api/app/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				conversationId: `app/reader-${delayMs}`,
				message: { id: "m2", role: "user", parts: [{ type: "text", text: "second" }] },
			}),
		});
		expect(second.status).toBe(202);
		const wire = await stream.text();
		expect(wire).toContain('"delta":"one"');
		expect(wire).toContain('"delta":"six"');
		expect(wire).toContain('"type":"finish"');
		expect(wire).toContain("data: [DONE]");
		await waitUntil(
			() => store.history(`app/reader-${delayMs}`).filter((message) => message.role === "assistant").length >= 1,
			"first reply persists",
		);
	} finally {
		http.stop();
	}
}

describe("POST does not interrupt an attached /stream reader", () => {
	test("an early mid-turn POST leaves the live stream intact", async () => {
		await verifyAttachedReaderSurvivesSecondPost(0);
	});

	test("a queued mid-turn POST leaves the live stream intact through finish", async () => {
		await verifyAttachedReaderSurvivesSecondPost(70);
	});
});
