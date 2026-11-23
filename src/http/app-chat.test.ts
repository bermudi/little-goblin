import { describe, expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Message } from "../message.ts";
import { sendFileTool } from "../agent/tools/send.ts";
import { speakTool } from "../agent/tools/speak.ts";
import { setLogFile } from "../log.ts";
import type { TurnDone } from "../turn/sink.ts";
import { sdkScript } from "../testkit/turn-script-sdk.ts";
import { claudeScript } from "../testkit/turn-script-claude.ts";
import { sleep, tmpDir, waitUntil } from "../testkit.ts";
import type { AppChannelDeps } from "./app-shared.ts";
import { APP_TOKEN_NAME, createAndChat, setup } from "./app-testing.ts";

const adapters = [sdkScript, claudeScript] as const;
const engineName = (make: (typeof adapters)[number]) =>
	make === sdkScript ? "ai-sdk" : "claude-code";

describe("app chat", () => {
	test("draft model choice applies only to a newly minted rolling chat", async () => {
		const { http, call, store, configRef, configWrites } = setup({ token: APP_TOKEN_NAME });
		try {
			const sent = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					rolling: true,
					initialModelSettings: { model: "zai/m2", thinking: "high" },
					message: {
						id: "draft-model-roll",
						role: "user",
						parts: [{ type: "text", text: "hello" }],
					},
				}),
			});
			expect(sent.status).toBe(202);
			const roll = store.currentAppRoll();
			expect(roll).not.toBeNull();
			expect(store.readAppSettings(roll!.id, configRef.current)).toEqual({
				model: "zai/m2",
				thinking: "high",
			});
			expect(configRef.current).toMatchObject({ model: "zai/m", thinking: "medium" });
			expect(configWrites.count).toBe(0);
			await waitUntil(() => store.history(roll!.id).length === 2, "first rolling reply");
			const historyLength = store.history(roll!.id).length;
			const staleChoice = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					rolling: true,
					initialModelSettings: { model: "zai/m", thinking: "medium" },
					message: {
						id: "stale-draft-model-roll",
						role: "user",
						parts: [{ type: "text", text: "second" }],
					},
				}),
			});
			expect(staleChoice.status).toBe(409);
			expect(store.history(roll!.id)).toHaveLength(historyLength);
		} finally {
			http.stop();
		}
	});

	// This uses a real OpenAI-compatible HTTP provider to verify request rejection and error framing.
	test("a provider rejection before streaming emits one error and an error finish", async () => {
		let announceRequest!: () => void;
		const requestReceived = new Promise<void>((resolve) => {
			announceRequest = resolve;
		});
		let releaseResponse!: () => void;
		const responseReleased = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		const fixture = Bun.serve({
			port: 0,
			async fetch() {
				announceRequest();
				await responseReleased;
				return Response.json(
					{ error: { message: "invalid request shape", type: "invalid_request_error" } },
					{ status: 400 },
				);
			},
		});
		const model = createOpenAI({
			baseURL: `http://127.0.0.1:${fixture.port}/v1`,
			apiKey: "test",
		}).chat("test-model");
		const { http, call, store, runtime } = setup({ token: APP_TOKEN_NAME, model });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "pre-stream-failure" }),
			});
			const submitted = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/pre-stream-failure",
					message: {
						id: "probe-message",
						role: "user",
						parts: [{ type: "text", text: "pre-stream refusal" }],
					},
				}),
			});
			expect(submitted.status).toBe(202);
			await requestReceived;
			const streamPromise = call("/api/app/conversations/pre-stream-failure/stream");
			await waitUntil(
				() => runtime.hasConversationWatchers("app/pre-stream-failure"),
				"stream watcher attaches",
			);
			releaseResponse();
			const streamResponse = await streamPromise;
			expect(streamResponse.status).toBe(200);
			const reader = streamResponse.body!.getReader();
			const decoder = new TextDecoder();
			let body = "";
			while (!body.includes("data: [DONE]")) {
				const part = await reader.read();
				if (part.done) break;
				body += decoder.decode(part.value, { stream: true });
			}
			await reader.cancel();
			const records = body
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.map((line) => line.slice("data: ".length));
			expect(records.map((record) => record === "[DONE]" ? record : JSON.parse(record))).toEqual([
				expect.objectContaining({ type: "start", messageId: expect.any(String) }),
				{ type: "error", errorText: "invalid request shape" },
				{ type: "finish", finishReason: "error" },
				"[DONE]",
			]);
			await waitUntil(
				() => store.history("app/pre-stream-failure").length === 2,
				"failed reply persists",
			);
			expect(store.history("app/pre-stream-failure").map((message) => message.role)).toEqual(["user", "system"]);
			expect(
				store.db
					.query<{ status: string; delivery: string }, [string]>(
						"SELECT status, delivery FROM turn_runs WHERE conversation_id = ?",
					)
					.get("app/pre-stream-failure"),
			).toMatchObject({ status: "error", delivery: "failed" });
		} finally {
			releaseResponse();
			http.stop();
			await fixture.stop();
		}
	});

	test("chat submits a user message with 202 and persists its reply", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ submitted: true });
			await waitUntil(() => store.history("app/chat-01").length === 2, "reply persists");
			expect(store.history("app/chat-01").map((m) => m.role)).toEqual(["user", "assistant"]);
			expect(store.history("app/chat-01")[1]!.parts).toContainEqual(
				expect.objectContaining({ type: "text", text: "hello app" }),
			);
		} finally {
			http.stop();
		}
	});

	test("rolling chat mints, joins, and starts a fresh app conversation after a new-subject check", async () => {
		const model = sdkScript();
		model.script(
			{ kind: "reply", parts: [{ type: "text", text: "first reply" }] },
			{ kind: "reply", parts: [{ type: "text", text: "second reply" }] },
			{ kind: "reply", parts: [{ type: "text", text: "third reply" }] },
		);
		const gateCalls: string[] = [];
		const { http, call, store, configRef } = setup({
			token: APP_TOKEN_NAME,
			scriptedModel: model,
			gate: () => ({
				decide: async (state) => {
					gateCalls.push(JSON.stringify(state));
					return { answers: { follow_up: 0.1 }, inputTokens: 1, cost: 0 };
				},
			}),
		});
		configRef.current.telegram.dmGapMinutes = 0;
		const send = (id: string, text: string) =>
			call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					rolling: true,
					message: { id, role: "user", parts: [{ type: "text", text }] },
				}),
			});
		try {
			const first = await send("roll-1", "private first roll text");
			expect(first.status).toBe(202);
			const firstBody = await first.json() as { submitted: boolean; conversationId: string; rolled: boolean };
			expect(firstBody).toMatchObject({ submitted: true, rolled: true });
			expect(firstBody.conversationId).toMatch(/^app\//);
			await waitUntil(() => store.history(firstBody.conversationId).length === 2, "first rolling reply");
			configRef.current.telegram.dmGapMinutes = 45;
			const second = await send("roll-2", "inside quiet gap");
			const secondBody = await second.json() as { conversationId: string; rolled: boolean; submitted: boolean };
			expect(second.status).toBe(202);
			expect(secondBody).toEqual({ conversationId: firstBody.conversationId, rolled: false, submitted: true });
			await waitUntil(() => store.history(firstBody.conversationId).length === 4, "second rolling reply");
			const beforeRoll = JSON.stringify(store.history(firstBody.conversationId));

			configRef.current.telegram.dmGapMinutes = 0;
			const third = await send("roll-3", "unrelated new topic");
			const thirdBody = await third.json() as { conversationId: string; rolled: boolean };
			expect(third.status).toBe(202);
			expect(thirdBody.rolled).toBe(true);
			expect(thirdBody.conversationId).not.toBe(firstBody.conversationId);
			await waitUntil(() => store.history(thirdBody.conversationId).length === 2, "third rolling reply");
			expect(JSON.stringify(store.history(firstBody.conversationId))).toBe(beforeRoll);
			expect(gateCalls).toHaveLength(1);
			expect(model.requests()).toHaveLength(3);
			expect(model.requests()[2]).not.toContain("private first roll text");
		} finally {
			http.stop();
		}
	});

	test("rolling chat refuses a conversation id, retry, edit, or missing message", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		const message = { id: "invalid-roll", role: "user", parts: [{ type: "text", text: "hi" }] };
		try {
			for (const body of [
				{ rolling: true, conversationId: "app/one", message },
				{ rolling: true, retry: true, message },
				{ rolling: true, editMessageId: "x", message },
				{ rolling: true },
			]) {
				const res = await call("/api/app/chat", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				expect(res.status).toBe(422);
			}
		} finally {
			http.stop();
		}
	});

	for (const make of adapters) test(`${engineName(make)}: a failed mid-stream turn reports an error finish reason`, async () => {
		const model = make();
		model.script({
			kind: "fail",
			parts: [{ type: "text", text: "partial" }],
			error: { message: "invalid response chunk" },
		});
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			scriptedModel: model,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "failed-stream" }),
			});
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/failed-stream",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ submitted: true });
			await waitUntil(() => store.history("app/failed-stream").length === 2, "failed reply persists");
			const history = store.history("app/failed-stream");
			expect(history.map((message) => message.role)).toEqual(["user", "system"]);
			expect(history[1]!.id).toBeTruthy();
			expect(JSON.stringify(history[1]!.parts)).toContain("partial");
		} finally {
			http.stop();
		}
	});

	// #206: the compact- prefix is a server label, but the id is the
	// client's to choose — intake must accept it and store it verbatim;
	// downstream classification keys on the store-assigned seq, not the id.
	test("a client-chosen compact-prefixed id is accepted and stored verbatim", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "forged-01" }),
			});
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/forged-01",
					message: {
						id: "compact-7",
						role: "user",
						parts: [{ type: "text", text: "remember the lighthouse" }],
					},
				}),
			});
			expect(res.status).toBe(202);
			await res.text();
			expect(store.history("app/forged-01").map((m) => m.id)).toEqual([
				"compact-7",
				expect.any(String),
			]);
		} finally {
			http.stop();
		}
	});

	test("a malformed part payload is refused before persistence — no poison pill", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "poison-01" }),
			});
			// A wrong-typed text payload converts cleanly, would persist,
			// and then fails every later turn at standardizePrompt — the
			// boundary must refuse it before anything is written.
			const badText = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/poison-01",
					message: { id: "m-bad", role: "user", parts: [{ type: "text", text: 12345 }] },
				}),
			});
			expect(badText.status).toBe(422);
			await badText.text();
			const badFile = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/poison-01",
					message: {
						id: "m-bad-file",
						role: "user",
						parts: [{ type: "file", url: "https://x.example/a.png" }],
					},
				}),
			});
			expect(badFile.status).toBe(422);
			await badFile.text();
			// The refusals left nothing behind: a later well-formed turn
			// runs to completion on the same conversation.
			expect(store.history("app/poison-01")).toEqual([]);
			const good = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/poison-01",
					message: { id: "m-good", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(good.status).toBe(202);
			await good.text();
			await waitUntil(() => store.history("app/poison-01").length === 2, "good turn settles");
			expect(store.history("app/poison-01").map((m) => m.role)).toEqual(["user", "assistant"]);
		} finally {
			http.stop();
		}
	});

	for (const make of adapters) test(`${engineName(make)}: generated files and voice notes persist durably and stream live`, async () => {
		const work = tmpDir("goblin-app-media-");
		writeFileSync(join(work, "note.txt"), "file-bytes");
		const audio = new Uint8Array([9, 8, 7]);
		const model = make();
		model.script(
			{
				kind: "reply",
				parts: [
					{ type: "tool-call", toolName: "send_file", input: { path: "note.txt", caption: "keepsake" } },
					{ type: "tool-call", toolName: "speak", input: { text: "hello" } },
				],
			},
			{ kind: "reply", parts: [{ type: "text", text: "sent" }] },
		);
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			scriptedModel: model,
			makeTools: (_conv, deliverVoice, _recording, deliverFile) => ({
				send_file: sendFileTool(work, deliverFile!),
				speak: speakTool(work, async () => [audio], deliverVoice!),
			}),
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-media" }),
			});
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-media",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "send media" }] },
				}),
			});
			expect(res.status).toBe(202);
			await res.json();
			await waitUntil(
				() =>
					store
						.history("app/chat-media")
						.flatMap((message) => message.parts)
						.filter((part) => part.type === "data-attachment").length === 2,
				"media parts persist",
			);

			const detail = store.historyDetail("app/chat-media");
			expect(detail.map((e) => e.message.role)).toEqual([
				"user",
				"assistant",
				"assistant",
				"assistant",
			]);
			const media = detail.filter((e) => e.message.parts.some((p) => p.type === "data-attachment"));
			expect(media).toHaveLength(2);
			expect(media.map((e) => e.anchorSeq)).toEqual([1, 1]);

			const reopened = (await (
				await call("/api/app/conversations/chat-media/messages")
			).json()) as { messages: Message[] };
			const refs = reopened.messages.flatMap((m) =>
				m.parts
					.filter((p) => p.type === "data-attachment")
					.map((p) => (p as { data: { path: string; mediaType: string; filename: string } }).data),
			);
			expect(refs.map((r) => r.filename).sort()).toEqual(["note.txt", "voice-note.ogg"]);

			const fileRef = refs.find((r) => r.filename === "note.txt")!;
			const fileGet = await call(
				`/api/app/attachments/${encodeURIComponent(basename(fileRef.path))}`,
			);
			expect(fileGet.status).toBe(200);
			expect(await fileGet.text()).toBe("file-bytes");
			const voiceRef = refs.find((r) => r.filename === "voice-note.ogg")!;
			const voiceGet = await call(
				`/api/app/attachments/${encodeURIComponent(basename(voiceRef.path))}`,
			);
			expect(voiceGet.status).toBe(200);
			expect(voiceGet.headers.get("content-type")).toBe("audio/ogg");
			expect([...new Uint8Array(await voiceGet.arrayBuffer())]).toEqual([9, 8, 7]);
		} finally {
			http.stop();
		}
	});

	test("long silent stretches get SSE comment pings — the wire never idles out", async () => {
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b"],
			delayMs: 6_000,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-ping" }),
			});
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-ping",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(res.status).toBe(202);
			await res.json();
			const stream = await call("/api/app/conversations/chat-ping/stream");
			const body = await stream.text();
			expect(body).toContain(": ping\n\n");
			const frames = body
				.split("\n\n")
				.filter((f) => f.startsWith("data: "))
				.map((f) => f.slice("data: ".length));
			expect(frames.at(-1)).toBe("[DONE]");
			const chunks = frames.slice(0, -1).map((f) => JSON.parse(f) as { type: string });
			expect(chunks.map((c) => c.type)).toContain("finish");
		} finally {
			http.stop();
		}
	}, 20_000);

	test("a data-attachment part must name a file the pipeline wrote", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const chat = (ref: Record<string, unknown>) =>
				call("/api/app/chat", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						conversationId: "app/chat-01",
						message: { id: "m1", role: "user", parts: [{ type: "data-attachment", data: ref }] },
					}),
				});
			const base = { mediaType: "text/plain", filename: "x", size: 1 };
			expect((await chat({ ...base, path: join(home, "goblin.sqlite") })).status).toBe(422);
			expect(
				(await chat({ ...base, path: join(home, "workspace", "attachments", "..", "evil") }))
					.status,
			).toBe(422);
			const form = new FormData();
			form.append(
				"file",
				new Blob([new Uint8Array([1, 2, 3])], { type: "text/plain" }),
				"note.txt",
			);
			const up = await call("/api/app/attachments", { method: "POST", body: form });
			const { ref } = (await up.json()) as { ref: Record<string, unknown> };
			const ok = await chat(ref);
			expect(ok.status).toBe(202);
			expect(await ok.json()).toEqual({ submitted: true });
		} finally {
			http.stop();
		}
	});

	test("a data-skill part validates name and temp path against the cache", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-skill" }),
			});
			const chat = (data: Record<string, unknown>) =>
				call("/api/app/chat", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						conversationId: "app/chat-skill",
						message: { id: "m1", role: "user", parts: [{ type: "data-skill", data }] },
					}),
				});
			expect((await chat({ name: "Bad Name" })).status).toBe(422);
			expect((await chat({ name: "../escape" })).status).toBe(422);
			expect(
				(await chat({ url: "https://github.com/o/r/tree/main/demo", path: "/etc/passwd" })).status,
			).toBe(422);
			// A support file under the cache is not the descriptor's
			// SKILL.md — only the exact cached body shape passes.
			const digestDir = join(home, "state", "skillcache", "d".repeat(64));
			const { mkdirSync, writeFileSync } = await import("node:fs");
			mkdirSync(join(digestDir, "demo"), { recursive: true });
			writeFileSync(join(digestDir, "demo", "payload.txt"), "x");
			expect(
				(
					await chat({
						url: "https://github.com/o/r/tree/main/demo",
						path: join(digestDir, "demo", "payload.txt"),
					})
				).status,
			).toBe(422);
			// A staged copy under this home's skillcache passes and persists.
			const cached = join(digestDir, "demo", "SKILL.md");
			writeFileSync(cached, "x");
			const ok = await chat({
				url: "https://github.com/o/r/tree/main/demo",
				path: cached,
			});
			expect(ok.status).toBe(202);
			expect(await ok.json()).toEqual({ submitted: true });
		} finally {
			http.stop();
		}
	});

	test("app refuses skipped skills and injects valid catalog skills", async () => {
		const { http, call, home, store, windowCapture } = setup({ token: APP_TOKEN_NAME });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-skipped-skill" }),
			});
			const { mkdirSync, writeFileSync } = await import("node:fs");
			const skipped = join(home, "workspace", "skills", "broken", "SKILL.md");
			mkdirSync(join(home, "workspace", "skills", "broken"), { recursive: true });
			writeFileSync(skipped, "---\nname: broken\ndescription:\n---\nshould not inject");
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-skipped-skill",
					message: {
						id: "m1",
						role: "user",
						parts: [{ type: "data-skill", data: { name: "broken" } }],
					},
				}),
			});
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'no skill named "broken"' });
			expect(store.history("app/chat-skipped-skill")).toEqual([]);

			const validDir = join(home, "workspace", "skills", "valid");
			mkdirSync(validDir, { recursive: true });
			writeFileSync(
				join(validDir, "SKILL.md"),
				"---\nname: valid\ndescription: valid skill\n---\napp-injected-body",
			);
			const valid = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-skipped-skill",
					message: {
						id: "m2",
						role: "user",
						parts: [{ type: "data-skill", data: { name: "valid" } }],
					},
				}),
			});
			expect(valid.status).toBe(202);
			await waitUntil(
				() => store.history("app/chat-skipped-skill").length === 2,
				"valid skill turn settles",
			);
			expect(
				JSON.stringify(windowCapture.read("app/chat-skipped-skill")?.capture.messages),
			).toContain("app-injected-body");
		} finally {
			http.stop();
		}
	});

	test("chat refuses a non-app conversation id and an unknown one", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "dm-99",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(res.status).toBe(422);
			const missing = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/ghost",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(missing.status).toBe(404);
		} finally {
			http.stop();
		}
	});

	test("tts speaks the stripped spoken content, refusing what has none", async () => {
		const heard: string[] = [];
		const spoken = new Uint8Array([1]);
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			speak: async (text) => {
				heard.push(text);
				return [spoken];
			},
		});
		try {
			const res = await call("/api/app/tts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					text: "## Errand\n\n**buy** milk — see [docs](https://example.com/x)\n\n```js\ncode()\n```",
				}),
			});
			expect(res.status).toBe(200);
			// The client sends raw reply markdown; the voice never hears
			// the furniture ("the voice keeps reading asterisk asterisk").
			expect(heard).toEqual(["Errand\n\nbuy milk — see docs"]);
			const mute = await call("/api/app/tts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "```\ncode()\n```" }),
			});
			expect(mute.status).toBe(422);
			expect(((await mute.json()) as { error: string }).error).toBe(
				"nothing speakable in this reply",
			);
			expect(heard).toHaveLength(1);
		} finally {
			http.stop();
		}
	});

	test("tts serves base64 chunks when speech is wired, 503s otherwise", async () => {
		const { http: h1, call: c1 } = setup({ token: APP_TOKEN_NAME });
		try {
			const res = await c1("/api/app/tts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "read me" }),
			});
			expect(res.status).toBe(503);
		} finally {
			h1.stop();
		}

		const spoken = new Uint8Array([9, 8, 7]);
		const { http: h2, call: c2 } = setup({
			token: APP_TOKEN_NAME,
			speak: async () => [spoken],
		});
		try {
			const res = await c2("/api/app/tts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "read me" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { chunks: string[]; mediaType: string };
			expect(body.mediaType).toBe("audio/ogg");
			expect(body.chunks.map((c) => [...Buffer.from(c, "base64")])).toEqual([[9, 8, 7]]);
		} finally {
			h2.stop();
		}

		const { http: h3, call: c3 } = setup({ token: APP_TOKEN_NAME, speak: async () => null });
		try {
			expect(
				(
					await c3("/api/app/tts", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ text: "x" }),
					})
				).status,
			).toBe(503);
		} finally {
			h3.stop();
		}
	});

	test("the first turn auto-titles an unnamed conversation", async () => {
		const titled: string[] = [];
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			titleFor: async (text) => {
				titled.push(text);
				return "First Burst Title";
			},
		});
		try {
			await createAndChat(call, "what is the meaning of this");
			await waitUntil(() => store.get("app/chat-01")?.title !== null, "title lands");
			const conv = store.get("app/chat-01");
			expect(conv?.title).toBe("First Burst Title");
			expect(conv?.titleImplicit).toBe(false);
			expect(titled).toEqual(["what is the meaning of this"]);
		} finally {
			http.stop();
		}
	});

	test("a finished turn logs the stream finish — the boundary the log file must reconstruct", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME });
		const logFile = join(home, "goblin.log");
		setLogFile(logFile);
		try {
			await createAndChat(call, "log this finish");
		} finally {
			http.stop();
			setLogFile(null);
		}
		const lines = readFileSync(logFile, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { msg: string; conversation?: string; outcome?: string });
			const finish = lines.filter((l) => l.msg === "app conversation turn finish");
		expect(finish).toHaveLength(1);
		expect(finish[0]).toMatchObject({ conversation: "app/chat-01", outcome: "completed" });
	});

	test("a preset title keeps titleFor out of the first turn", async () => {
		let calls = 0;
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			titleFor: async () => {
				calls += 1;
				return "implicit";
			},
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01", title: "Named by hand" }),
			});
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			await res.text();
			await sleep(20);
			expect(calls).toBe(0);
			expect(store.get("app/chat-01")?.title).toBe("Named by hand");
		} finally {
			http.stop();
		}
	});

	test("a speech-flagged attachment gets its transcript before submit", async () => {
		const heard: { filename: string }[] = [];
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			transcribe: async (file) => {
				heard.push({ filename: file.filename });
				return "spoken words here";
			},
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const form = new FormData();
			form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" }), "note.ogg");
			const up = await call("/api/app/attachments", { method: "POST", body: form });
			const { ref } = (await up.json()) as { ref: Record<string, unknown> };

			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: {
						id: "m1",
						role: "user",
						parts: [{ type: "data-attachment", data: { ...ref, speech: true } }],
					},
				}),
			});
			expect(res.status).toBe(202);
			await res.json();
			expect(heard).toEqual([{ filename: "note.ogg" }]);
			const stored = store.history("app/chat-01")[0]!;
			const part = stored.parts[0] as { type: string; data: { transcript?: string } };
			expect(part.data.transcript).toBe("spoken words here");
		} finally {
			http.stop();
		}
	});

	test("retry re-runs the newest user message without duplicating it", async () => {
		const model = sdkScript();
		model.script(
			{ kind: "reply", parts: [{ type: "text", text: "first reply" }] },
			{ kind: "reply", parts: [{ type: "text", text: "retried reply" }] },
		);
		const { http, call, store, runtime } = setup({
			token: APP_TOKEN_NAME,
			scriptedModel: model,
		});
		try {
			await createAndChat(call);
			const events: { type: string; messageId?: string; replacedBy?: string }[] = [];
			const unsubscribe = runtime.subscribeConversation("app/chat-01", (event) => events.push(event));
			const originalAssistantId = store.history("app/chat-01")[1]!.id;
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ conversationId: "app/chat-01", retry: true }),
			});
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ submitted: true });
			expect(events[0]).toEqual({ type: "rewound", messageId: "m1", replacedBy: "m1" });
			await waitUntil(
				() => model.calls() === 2 && !runtime.busy("app/chat-01"),
				"retry settles",
			);
			const history = store.history("app/chat-01");
			expect(history.map((message) => message.role)).toEqual(["user", "assistant"]);
			expect(history[0]!.id).toBe("m1");
			expect(history[1]!.parts).toContainEqual(
				expect.objectContaining({ type: "text", text: "retried reply" }),
			);
			expect(history[1]!.id).not.toBe(originalAssistantId);
			unsubscribe();
		} finally {
			http.stop();
		}
	});

	test("retry removes the complete old tail after a tool call", async () => {
		const work = tmpDir("goblin-app-retry-tool-");
		writeFileSync(join(work, "old.txt"), "old tool artifact");
		const model = sdkScript();
		model.script(
			{
				kind: "reply",
				parts: [
					{
						type: "tool-call",
						toolName: "send_file",
						input: { path: "old.txt", caption: "old artifact" },
					},
				],
			},
			{ kind: "reply", parts: [{ type: "text", text: "old final reply" }] },
			{ kind: "reply", parts: [{ type: "text", text: "new retry reply" }] },
		);
		const { http, call, store, runtime } = setup({
			token: APP_TOKEN_NAME,
			scriptedModel: model,
			makeTools: (_conv, _deliverVoice, _recording, deliverFile) => ({
				send_file: sendFileTool(work, deliverFile!),
			}),
		});
		try {
			await createAndChat(call);
			await waitUntil(
				() => model.calls() === 2 && !runtime.busy("app/chat-01"),
				"tool reply settles",
			);
			const oldHistory = store.historyDetail("app/chat-01");
			expect(oldHistory.length).toBeGreaterThan(2);
			expect(oldHistory.flatMap((event) => event.message.parts).some((part) =>
				part.type === "data-attachment",
			)).toBe(true);

			const retry = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ conversationId: "app/chat-01", retry: true }),
			});
			expect(retry.status).toBe(202);
			await retry.json();
			await waitUntil(
				() => model.calls() === 3 && !runtime.busy("app/chat-01"),
				"retried tool turn settles",
			);
			const history = store.historyDetail("app/chat-01");
			expect(history.map((event) => event.message.role)).toEqual(["user", "assistant"]);
			expect(history.flatMap((event) => event.message.parts).some((part) =>
				part.type === "data-attachment",
			)).toBe(false);
			expect(history[1]!.message.parts).toContainEqual(
				expect.objectContaining({ type: "text", text: "new retry reply" }),
			);
		} finally {
			http.stop();
		}
	});

	test("retry sends the same model messages as the original turn", async () => {
		const model = sdkScript();
		model.script(
			{ kind: "reply", parts: [{ type: "text", text: "first reply" }] },
			{ kind: "reply", parts: [{ type: "text", text: "retried reply" }] },
		);
		const { http, call, runtime } = setup({
			token: APP_TOKEN_NAME,
			scriptedModel: model,
		});
		try {
			await createAndChat(call, "cache-stable question");
			const originalMessages: unknown = JSON.parse(model.requests()[0]!);
			const retry = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ conversationId: "app/chat-01", retry: true }),
			});
			expect(retry.status).toBe(202);
			await retry.json();
			await waitUntil(
				() => model.calls() === 2 && !runtime.busy("app/chat-01"),
				"retry request settles",
			);
			const retryMessages: unknown = JSON.parse(model.requests()[1]!);
			expect(retryMessages).toEqual(originalMessages);
		} finally {
			http.stop();
		}
	});

	test("the next turn sees only the replacement reply before its new user message", async () => {
		const model = sdkScript();
		model.script(
			{ kind: "reply", parts: [{ type: "text", text: "first reply" }] },
			{ kind: "reply", parts: [{ type: "text", text: "retried reply" }] },
			{ kind: "reply", parts: [{ type: "text", text: "next reply" }] },
		);
		const { http, call, runtime } = setup({
			token: APP_TOKEN_NAME,
			scriptedModel: model,
		});
		try {
			await createAndChat(call, "first question");
			const retry = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ conversationId: "app/chat-01", retry: true }),
			});
			expect(retry.status).toBe(202);
			await retry.json();
			await waitUntil(
				() => model.calls() === 2 && !runtime.busy("app/chat-01"),
				"retry settles",
			);

			const next = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: {
						id: "m2",
						role: "user",
						parts: [{ type: "text", text: "next question" }],
					},
				}),
			});
			expect(next.status).toBe(202);
			await next.json();
			await waitUntil(
				() => model.calls() === 3 && !runtime.busy("app/chat-01"),
				"next turn settles",
			);
			const messages = JSON.parse(model.requests()[2]!) as {
				role: string;
				content: { type: string; text?: string }[];
			}[];
			const chatMessages = messages.filter((message) => message.role !== "system");
			expect(chatMessages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
			const assistantTexts = chatMessages
				.filter((message) => message.role === "assistant")
				.flatMap((message) =>
					message.content.filter((part) => part.type === "text").map((part) => part.text),
				);
			expect(assistantTexts).toEqual(["retried reply"]);
		} finally {
			http.stop();
		}
	});

	test("retry refuses an empty history and a live lane", async () => {
		const { http, call, runtime } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b", "c"],
			delayMs: 50,
		});
		const events: { type: string }[] = [];
		const unsubscribe = runtime.subscribeConversation("app/chat-01", (event) => events.push(event));
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const empty = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ conversationId: "app/chat-01", retry: true }),
			});
			expect(empty.status).toBe(409);

			const chat = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			const busy = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ conversationId: "app/chat-01", retry: true }),
			});
			expect(busy.status).toBe(409);
			expect(events.some((event) => event.type === "rewound")).toBe(false);
			await call("/api/app/conversations/chat-01/stop", { method: "POST" });

			expect(
				(
					await call("/api/app/chat", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							conversationId: "app/chat-01",
							retry: true,
							message: { id: "m2", role: "user", parts: [{ type: "text", text: "x" }] },
						}),
					})
				).status,
			).toBe(422);
		} finally {
			unsubscribe();
			http.stop();
		}
	});

	test("a turn with no attached readers reaches the push owner at turn end", async () => {
		const pushed: { conversation: string; done: TurnDone }[] = [];
		const push: NonNullable<AppChannelDeps["push"]> = {
			status: () => Promise.resolve({ configured: true, subscriptions: [] }),
			ensurePublicKey: () => Promise.resolve("public"),
			register: () => Promise.resolve({ endpointHash: "hash" }),
			unregister: () => true,
			notifyDone: (conv, done) => {
				pushed.push({ conversation: conv.id, done });
				return Promise.resolve();
			},
		};
		const { http, call } = setup({ token: APP_TOKEN_NAME, delayMs: 80, push });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(res.status).toBe(202);
			await res.json();
			await waitUntil(() => pushed.length === 1, "push when nobody watches");
			expect(pushed[0]).toMatchObject({
				conversation: "app/chat-01",
				done: { kind: "completed" },
			});
		} finally {
			http.stop();
		}
	});

	test("an attached conversation watcher suppresses foreground push", async () => {
		const pushed: string[] = [];
		const push: NonNullable<AppChannelDeps["push"]> = {
			status: () => Promise.resolve({ configured: true, subscriptions: [] }),
			ensurePublicKey: () => Promise.resolve("public"),
			register: () => Promise.resolve({ endpointHash: "hash" }),
			unregister: () => true,
			notifyDone: (conv) => {
				pushed.push(conv.id);
				return Promise.resolve();
			},
		};
		const { http, call, runtime } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b", "c", "d", "e"],
			delayMs: 50,
			push,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "watched" }),
			});
			const events = await call("/api/app/conversations/watched/events");
			const eventReader = events.body!.getReader();
			await eventReader.read();
			await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/watched",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			await waitUntil(() => runtime.conversationLive("app/watched"), "wire opens");
			const stream = await call("/api/app/conversations/watched/stream");
			await waitUntil(() => runtime.hasConversationWatchers("app/watched"), "readers attach");
			await waitUntil(() => !runtime.busy("app/watched"), "turn finishes");
			expect(stream.status).toBe(200);
			expect(pushed).toEqual([]);
			await eventReader.cancel();
			await stream.body?.cancel();
		} finally {
			http.stop();
		}
	});

	test("a failed transcription keeps the attachment and the turn runs", async () => {
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			transcribe: () => Promise.reject(new Error("stt down")),
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const form = new FormData();
			form.append("file", new Blob([new Uint8Array([1])], { type: "audio/ogg" }), "n.ogg");
			const { ref } = (await (
				await call("/api/app/attachments", { method: "POST", body: form })
			).json()) as { ref: Record<string, unknown> };
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: {
						id: "m1",
						role: "user",
						parts: [{ type: "data-attachment", data: { ...ref, speech: true } }],
					},
				}),
			});
			expect(res.status).toBe(202);
			await res.json();
			await waitUntil(() => store.history("app/chat-01").length === 2, "turn settles");
			const stored = store.history("app/chat-01")[0]!;
			const part = stored.parts[0] as {
				data: { transcript?: string; transcriptionError?: string; path: string };
			};
			expect(part.data.transcript).toBeUndefined();
			expect(part.data.transcriptionError).toBe("stt down");
			expect(part.data.path).toBe(String(ref.path));
		} finally {
			http.stop();
		}
	});
});

describe("app chat edit (rewind)", () => {
	const postChat = (call: ReturnType<typeof setup>["call"], body: Record<string, unknown>) =>
		call("/api/app/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	test("an edit drops the tail, streams the replacement, and never reuses a seq", async () => {
		const { http, call, store, runtime } = setup({ token: APP_TOKEN_NAME });
		try {
			await createAndChat(call, "first question");
			const second = await postChat(call, {
				conversationId: "app/chat-01",
				message: { id: "m2", role: "user", parts: [{ type: "text", text: "second" }] },
			});
			expect(second.status).toBe(202);
			await second.json();
			await waitUntil(() => store.history("app/chat-01").length === 4, "second turn settles");
			expect(store.history("app/chat-01")).toHaveLength(4);
			const events: { type: string; messageId?: string; replacedBy?: string }[] = [];
			const unsubscribe = runtime.subscribeConversation("app/chat-01", (event) => events.push(event));

			const res = await postChat(call, {
				conversationId: "app/chat-01",
				editMessageId: "m1",
				message: {
					id: "m1b",
					role: "user",
					parts: [{ type: "text", text: "first, rewritten" }],
				},
			});
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ submitted: true });
			expect(events[0]).toEqual({ type: "rewound", messageId: "m1", replacedBy: "m1b" });
			await waitUntil(() => store.history("app/chat-01").length === 2, "edited reply settles");

			const history = store.historyDetail("app/chat-01");
			expect(history.map((e) => e.message.role)).toEqual(["user", "assistant"]);
			expect(history[0]!.message.id).toBe("m1b");
			expect(history[0]!.message.parts[0]).toEqual({
				type: "text",
				text: "first, rewritten",
			});
			// Seqs 1–4 were spent by the dropped exchange; the replacement
			// continues above them, so a stale rating or journal row can
			// never re-bind to the new turn.
			expect(history[0]!.seq).toBe(5);
			expect(history[1]!.seq).toBe(6);
			expect(history[1]!.anchorSeq).toBe(5);
			expect(store.messageEvent("app/chat-01", "m1")).toBeNull();
			expect(store.messageEvent("app/chat-01", "m2")).toBeNull();
			unsubscribe();
		} finally {
			http.stop();
		}
	});

	test("an edit is refused while a turn is running", async () => {
		const { http, call, runtime } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b", "c", "d", "e"],
			delayMs: 50,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const chat = await postChat(call, {
				conversationId: "app/chat-01",
				message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
			});
			expect(chat.status).toBe(202);
			await chat.json();
			await waitUntil(() => runtime.busy("app/chat-01"), "turn running");
			const edit = await postChat(call, {
				conversationId: "app/chat-01",
				editMessageId: "m1",
				message: { id: "m1b", role: "user", parts: [{ type: "text", text: "rewritten" }] },
			});
			expect(edit.status).toBe(409);
			expect(((await edit.json()) as { error: string }).error).toContain("running");
		} finally {
			http.stop();
		}
	});

	test("unknown and non-user targets refuse without touching the transcript", async () => {
		const { http, call, store, runtime } = setup({ token: APP_TOKEN_NAME });
		try {
			await createAndChat(call, "hello");
			const events: { type: string }[] = [];
			const unsubscribe = runtime.subscribeConversation("app/chat-01", (event) => events.push(event));
			const before = store.history("app/chat-01");
			const assistantId = store
				.historyDetail("app/chat-01")
				.find((e) => e.message.role === "assistant")!.message.id;
			const nonUser = await postChat(call, {
				conversationId: "app/chat-01",
				editMessageId: assistantId,
				message: { id: "x1", role: "user", parts: [{ type: "text", text: "rewrite" }] },
			});
			expect(nonUser.status).toBe(422);
			await nonUser.text();
			const unknown = await postChat(call, {
				conversationId: "app/chat-01",
				editMessageId: "ghost",
				message: { id: "x2", role: "user", parts: [{ type: "text", text: "rewrite" }] },
			});
			expect(unknown.status).toBe(404);
			await unknown.text();
			expect(events.some((event) => event.type === "rewound")).toBe(false);
			// The refusal happens before the store write — no half-rewind.
			expect(store.history("app/chat-01")).toEqual(before);
			// Retry and edit are different repairs and cannot combine.
			const both = await postChat(call, {
				conversationId: "app/chat-01",
				retry: true,
				editMessageId: "m1",
			});
			expect(both.status).toBe(422);
			await both.text();
			unsubscribe();
		} finally {
			http.stop();
		}
	});
});
