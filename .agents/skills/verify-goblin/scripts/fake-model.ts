#!/usr/bin/env bun
// A scripted OpenAI-style Chat Completions endpoint, so a verification turn
// exercises goblin's real provider path without a paid model or a real key.
// It replies "verify-reply: <the last user message>". A message containing
// "[slow]" streams one word every 400ms (time to press Stop); "[fail]"
// streams a few words, then breaks the connection.

import { writeFileSync } from "node:fs";
import { z } from "zod";

const portFile = z.string().min(1).parse(process.argv[2]);

const requestSchema = z.object({
	stream: z.boolean().optional(),
	messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	const parts = z.array(z.object({ text: z.string().optional() })).safeParse(content);
	return parts.success ? parts.data.map((part) => part.text ?? "").join("") : "";
}

function chunk(delta: object, finish: string | null): string {
	const body = {
		id: "verify",
		object: "chat.completion.chunk",
		created: 0,
		model: "verify-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
	return `data: ${JSON.stringify(body)}\n\n`;
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		const { pathname } = new URL(req.url);
		process.stdout.write(`${req.method} ${pathname}\n`);
		if (pathname.endsWith("/models")) {
			return Response.json({ object: "list", data: [{ id: "verify-model", object: "model" }] });
		}
		if (!pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const parsed = requestSchema.safeParse(await req.json());
		if (!parsed.success)
			return Response.json({ error: { message: "bad request" } }, { status: 400 });
		const last = parsed.data.messages.filter((message) => message.role === "user").at(-1);
		const reply = `verify-reply: ${textOf(last?.content)}`;
		if (parsed.data.stream !== true) {
			return Response.json({
				id: "verify",
				object: "chat.completion",
				created: 0,
				model: "verify-model",
				choices: [
					{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		}
		const headers = { "content-type": "text/event-stream" };
		const slow = reply.includes("[slow]");
		const fail = reply.includes("[fail]");
		if (!slow && !fail) {
			const stream = [
				chunk({ role: "assistant", content: reply }, null),
				chunk({}, "stop"),
				"data: [DONE]\n\n",
			].join("");
			return new Response(stream, { headers });
		}
		const words = slow ? Array.from({ length: 40 }, (_, i) => `word${i} `) : ["partial ", "text "];
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				controller.enqueue(enc.encode(chunk({ role: "assistant", content: "" }, null)));
				for (const w of words) {
					controller.enqueue(enc.encode(chunk({ content: w }, null)));
					await Bun.sleep(slow ? 400 : 100);
				}
				if (fail) {
					controller.error(new Error("verify: scripted mid-stream failure"));
					return;
				}
				controller.enqueue(enc.encode(chunk({}, "stop")));
				controller.enqueue(enc.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return new Response(body, { headers });
	},
});
writeFileSync(portFile, String(server.port));
