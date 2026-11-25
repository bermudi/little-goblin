#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const portFile = z.string().min(1).parse(process.argv[2]);

const requestSchema = z.object({
	stream: z.boolean().optional(),
	messages: z.array(
		z.object({
			role: z.string(),
			content: z.unknown(),
			tool_call_id: z.string().optional(),
			tool_calls: z
				.array(
					z.object({
						id: z.string(),
						function: z.object({ name: z.string(), arguments: z.string() }),
					}),
				)
				.optional(),
		}),
	),
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

type Message = z.infer<typeof requestSchema>["messages"][number];
type Json = Record<string, unknown>;

function toolJson(content: unknown): Json | null {
	const text = textOf(content);
	try {
		const v: unknown = JSON.parse(text);
		if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
		const obj = v as Json;
		// goblin wraps json tool output as {type:"json",value} — unwrap.
		if (obj.type === "json" && typeof obj.value === "object" && obj.value !== null) {
			return obj.value as Json;
		}
		return obj;
	} catch {
		return null;
	}
}

function toolCallResponse(
	name: string,
	args: Json,
	stream: boolean,
	id = `call-verify-${name}`,
	beforeCall?: string,
): Response {
	const toolCall = {
		id,
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
	};
	if (!stream) {
		return Response.json({
			id: "verify",
			object: "chat.completion",
			created: 0,
			model: "verify-model",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: null, tool_calls: [toolCall] },
					finish_reason: "tool_calls",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
	}
	const headers = { "content-type": "text/event-stream" };
	return new Response(
		[
			...(beforeCall === undefined ? [] : [chunk({ content: beforeCall }, null)]),
			chunk(
				{ role: "assistant", content: null, tool_calls: [{ ...toolCall, index: 0 }] },
				null,
			),
			chunk({}, "tool_calls"),
			"data: [DONE]\n\n",
		].join(""),
		{ headers },
	);
}

// --- computer child (issue #605) -------------------------------------
// Same probe page as src/desktops.live.test.ts: the button's onclick
// sets document.title='clicked'.
const PROBE_HTML = `<!doctype html><html><body>
<input id="in" autofocus oninput="document.title='typed:'+this.value">
<button id="btn" style="width:400px;height:200px" onclick="document.title='clicked'">CLICK</button>
</body></html>`;
const PROBE_URL = "file:///tmp/probe.html";
const COMPUTER_CHILD_MARKER = "computer-use agent";
// Set when the parent's [computer ...] marker emits the spawn; the
// child's requests carry no marker, so the script keys off this.
let computerDesktop: string | null = null;
let computerSpawned = false;
let computerAllocTries = 0;
let probeCopied = false;

// The spawn claim has already created and started the desktop container
// before the child's first request lands, so the cp always has a target.
async function ensureProbe(container: string): Promise<void> {
	if (probeCopied) return;
	const tmp = join(tmpdir(), `goblin-verify-probe-${process.pid}.html`);
	writeFileSync(tmp, PROBE_HTML);
	const r = Bun.spawn(["podman", "cp", tmp, `${container}:/tmp/probe.html`]);
	const code = await r.exited;
	if (code === 0) {
		probeCopied = true;
	} else {
		process.stderr.write(`probe cp to ${container} failed (exit ${code})\n`);
	}
}

function isComputerChild(messages: Message[]): boolean {
	return messages.some(
		(m) => (m.role === "system" || m.role === "developer") && textOf(m.content).includes(COMPUTER_CHILD_MARKER),
	);
}

interface ChildStep {
	call: { name: string; args: Json } | null;
	text: string;
}

// Recompute the whole script from tool history each request — the fake
// is stateless like a real model would be.
function computerChildNext(messages: Message[]): ChildStep {
	const nameById = new Map<string, string>();
	for (const m of messages) {
		for (const tc of m.tool_calls ?? []) nameById.set(tc.id, tc.function.name);
	}
	const results: { name: string; json: Json | null }[] = [];
	for (const m of messages) {
		if (m.role !== "tool") continue;
		const json = toolJson(m.content);
		if (json === null) {
			process.stderr.write(
				`computer-child: unparseable tool result (${nameById.get(m.tool_call_id ?? "") ?? "?"}): ${textOf(m.content).slice(0, 200)}\n`,
			);
		}
		results.push({ name: nameById.get(m.tool_call_id ?? "") ?? "?", json });
	}
	const done = (text: string): ChildStep => ({ call: null, text });
	const call = (name: string, args: Json): ChildStep => ({ call: { name, args }, text: "" });
	if (results.length >= 150) return done("computer-verify: exhausted the tool-call budget");

	const ok = (r: { json: Json | null } | undefined): boolean =>
		r !== undefined && r.json !== null && r.json.error === undefined && r.json.result !== undefined;
	const inspectIdx = results.map((r, i) => (r.name === "inspect" && r.json?.observation_id !== undefined ? i : -1)).filter((i) => i >= 0);
	const lastInspect = inspectIdx.length > 0 ? results[inspectIdx.at(-1)!]! : undefined;
	const last = results.at(-1);
	const launchOkIdx = results.findIndex((r) => r.name === "launch" && ok(r));
	const actOkIdx = results.findIndex((r) => r.name === "act" && ok(r));
	const actAttempts = results.filter((r) => r.name === "act").length;

	// Any tool error → fresh inspect (recovers session boot, stale obs,
	// refused actions) before the next step.
	if (last !== undefined && last.json?.error !== undefined) return call("inspect", {});

	if (launchOkIdx === -1) {
		if (lastInspect === undefined) return call("inspect", {});
		return call("launch", { observation_id: lastInspect.json!.observation_id, url: PROBE_URL });
	}

	if (actOkIdx === -1) {
		if (actAttempts >= 5) {
			return done(`computer-verify: act kept failing — last=${JSON.stringify(last?.json ?? null).slice(0, 300)}`);
		}
		// Wait for the chromium window's CLICK button, then click it by
		// element token — the element-driven path, not coordinates.
		const stateText = typeof lastInspect?.json?.state === "string" ? lastInspect.json.state : "";
		let button: { element_token?: string } | undefined;
		let pid: number | undefined;
		try {
			const state = JSON.parse(stateText) as { elements?: { role?: string; label?: string; element_token?: string }[]; pid?: number };
			button = (state.elements ?? []).find(
				(e) => e.role === "button" && /click/i.test(e.label ?? "") && e.element_token !== undefined,
			);
			pid = state.pid;
		} catch {
			// state unparseable — keep polling
		}
		if (button?.element_token === undefined || pid === undefined) return call("inspect", {});
		return call("act", {
			observation_id: lastInspect!.json!.observation_id,
			tool: "click",
			args: { element_token: button.element_token, pid },
		});
	}

	// Act consumed its observation — one fresh inspect verifies the
	// title actually changed, then the child reports.
	const verifyIdx = results.findIndex((r, i) => i > actOkIdx && r.name === "inspect");
	if (verifyIdx === -1) return call("inspect", {});
	const verify = results[verifyIdx]!;
	const stateJson = typeof verify.json?.state === "string" ? verify.json.state : JSON.stringify(verify.json ?? {});
	const clicked = /clicked/i.test(stateJson);
	const actResult = results[actOkIdx]!.json?.result;
	return done(
		`computer-verify: DONE title-clicked=${clicked} act=${JSON.stringify(actResult ?? null).slice(0, 200)}`,
	);
}

function longReplyLines(): string[] {
	const lines = ["# verify-long: the head of the answer", ""];
	for (let section = 1; section <= 6; section += 1) {
		lines.push(`## Section ${section}`, "");
		for (let p = 1; p <= 3; p += 1) {
			lines.push(
				`Paragraph ${section}.${p}: a line long enough to wrap on a phone screen, so the reply grows the way a real answer does while it streams in.`,
				"",
			);
		}
		lines.push("- first point", "- second point", "- third point", "");
		if (section % 2 === 0) lines.push("```ts", `const section = ${section};`, "console.log(section);", "```", "");
	}
	lines.push("verify-long: the tail of the answer");
	return lines;
}

function longReply(): Response {
	const enc = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(enc.encode(chunk({ role: "assistant", content: "" }, null)));
			for (const line of longReplyLines()) {
				controller.enqueue(enc.encode(chunk({ content: `${line}\n` }, null)));
				await Bun.sleep(60);
			}
			controller.enqueue(enc.encode(chunk({}, "stop")));
			controller.enqueue(enc.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function workReply(step: number, thinkOnly: boolean): Response {
	const enc = new TextEncoder();
	const thought = step === 0
		? "**Inspecting the log**\n\nI am inspecting the log and checking the details carefully before choosing the next action to take."
		: "I am reviewing the intermediate result and checking the details of the next file before I continue with the remaining work in this reply. This second sentence should not appear in the preview.";
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(enc.encode(chunk({ role: "assistant", content: step === 1 ? "Between calls." : "" }, null)));
			if (step === 1) await Bun.sleep(4000);
			controller.enqueue(enc.encode(chunk({ reasoning_content: " " }, null)));
			await Bun.sleep(500);
			for (const word of thought.match(/\S+\s*/g) ?? []) {
				controller.enqueue(enc.encode(chunk({ reasoning_content: word }, null)));
				await Bun.sleep(150);
			}
			if (thinkOnly) controller.enqueue(enc.encode(chunk({ content: "verify-think: done" }, null)));
			else {
				const name = step === 0 ? "bash" : "read_file";
				const args = step === 0 ? { command: "sleep 4 && sed -n 1p ../state/goblin.log" } : { path: "../state/goblin.log" };
				controller.enqueue(enc.encode(chunk({ tool_calls: [{ index: 0, id: `call-verify-work-${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null)));
			}
			controller.enqueue(enc.encode(chunk({}, thinkOnly ? "stop" : "tool_calls")));
			controller.enqueue(enc.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function reviewMarker(text: string): { writes: string[]; score: string } | null {
	const match = /\[review (new|edit|both) (down|[01](?:\.\d+)?)\]/.exec(text);
	if (match === null) return null;
	const writes = {
		new: ["verify-review-new"],
		edit: ["verify-example"],
		both: ["verify-example", "verify-review-new"],
	}[match[1] as "new" | "edit" | "both"];
	return { writes, score: match[2]! };
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		const { pathname } = new URL(req.url);
		process.stdout.write(`${req.method} ${pathname}\n`);
		if (req.method === "POST" && pathname === "/api/alpha/decisions") {
			const body = z
				.object({
					model: z.string(),
					state: z.string(),
					questions: z.record(
						z.string(),
						z.object({
							type: z.literal("noul"),
							instructions: z.string(),
							criteria: z.object({ true: z.string(), false: z.string() }),
						}),
					),
				})
				.safeParse(await req.json().catch(() => null));
			if (!body.success) return Response.json({ error: "bad request" }, { status: 400 });
			const { state, questions } = body.data;
			if ("correction" in questions || "reuse" in questions) {
				const review = reviewMarker(state);
				const scores: Record<string, number> = {
					correction: 0,
					procedure: review === null ? 0 : 0.9,
					reuse: Number(review?.score ?? 0),
				};
				if ("reuse" in questions && review?.score === "down")
					return Response.json({ error: "down" }, { status: 503 });
				return Response.json({
					answers: Object.fromEntries(
						Object.keys(questions).map((id) => [id, { type: "noul", noul: scores[id] }]),
					),
				});
			}
			let next: string;
			try {
				const state = z.object({ next: z.string() }).parse(JSON.parse(body.data.state));
				next = state.next;
			} catch {
				return Response.json({ error: "bad request" }, { status: 400 });
			}
			const fresh = next.includes("[new topic]");
			return Response.json({
				answers: { follow_up: { type: "noul", noul: fresh ? 0.05 : 0.9 } },
			});
		}
		if (pathname.endsWith("/models")) {
			return Response.json({ object: "list", data: [{ id: "verify-model", object: "model" }] });
		}
		if (!pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const parsed = requestSchema.safeParse(await req.json());
		if (!parsed.success)
			return Response.json({ error: { message: "bad request" } }, { status: 400 });
		const last = parsed.data.messages.filter((message) => message.role === "user").at(-1);
		const system = textOf(parsed.data.messages.find((message) => message.role === "system")?.content);
		const review = system.startsWith("You are goblin's skill reviewer")
			? reviewMarker(textOf(last?.content))
			: null;
		if (review !== null) {
			const step = parsed.data.messages.filter((message) => message.role === "tool").length;
			const name = review.writes[step];
			if (name !== undefined) {
				const content = `---\nname: ${name}\ndescription: Written by a verification review.\n---\n\nSay hi.\n`;
				return toolCallResponse(
					"write_file",
					{ path: `${name}/SKILL.md`, content },
					parsed.data.stream === true,
					`call-verify-review-${step}`,
				);
			}
		}
		let reply = `verify-reply: ${textOf(last?.content)}`;
		// "[agent <task>]" (issue #604's verification): the FIRST call of
		// a turn — no tool results yet — answers with one `agent` tool
		// call that spawns a foreground child on the task. The child's
		// own turn then lands here with the task as its last user
		// message and gets the plain echo, so the parent receives
		// "verify-reply: <task>" as the child's claim.
		const agentMarker = /\[agent ([^\]]+)\]/.exec(reply);
		const seenToolResult = parsed.data.messages.some((message) => message.role === "tool");
		if (agentMarker !== null && !seenToolResult) {
			return toolCallResponse(
				"agent",
				{ action: "spawn", task: agentMarker[1]!.trim(), background: false },
				parsed.data.stream === true,
			);
		}
		// "[computer <desktop> <task>]" (issue #605): a desktop must be
		// allocated before spawn can claim it, so the first call runs the
		// `desktop` tool's new action; the next call (its result in
		// history) emits the foreground computer spawn.
		const computerMarker = /\[computer ([a-z0-9][a-z0-9-]{0,30}) ([^\]]+)\]/.exec(reply);
		if (computerMarker !== null && !computerSpawned) {
			computerDesktop = computerMarker[1]!;
			if (!seenToolResult) {
				return toolCallResponse(
					"desktop",
					{ action: "new", name: computerDesktop },
					parsed.data.stream === true,
				);
			}
			const alloc = toolJson(parsed.data.messages.filter((m) => m.role === "tool").at(-1)?.content);
			if (alloc?.error !== undefined) {
				computerAllocTries += 1;
				if (computerAllocTries < 3) {
					return toolCallResponse(
						"desktop",
						{ action: "new", name: computerDesktop },
						parsed.data.stream === true,
					);
				}
				reply = `verify-reply: desktop new kept failing: ${JSON.stringify(alloc.error).slice(0, 300)}`;
			} else {
				computerSpawned = true;
				return toolCallResponse(
					"agent",
					{
						action: "spawn",
						type: "computer",
						task: computerMarker[2]!.trim(),
						desktop: computerDesktop,
						background: false,
					},
					parsed.data.stream === true,
				);
			}
		}
		if (computerSpawned && computerMarker !== null && seenToolResult) {
			// The spawn settled — surface the child's claim, not the marker.
			const toolMsg = parsed.data.messages.filter((m) => m.role === "tool").at(-1);
			const j = toolJson(toolMsg?.content);
			reply = `verify-reply: ${typeof j?.result === "string" ? j.result : textOf(toolMsg?.content)}`;
		}
		if (computerDesktop !== null && isComputerChild(parsed.data.messages)) {
			await ensureProbe(`goblin-desk-${computerDesktop}`);
			const step = computerChildNext(parsed.data.messages);
			if (step.call !== null) {
				return toolCallResponse(step.call.name, step.call.args, parsed.data.stream === true);
			}
			reply = step.text;
		}
		const lastUserIndex = parsed.data.messages.findLastIndex((message) => message.role === "user");
		const toolAfterLastUser = parsed.data.messages
			.slice(lastUserIndex + 1)
			.some((message) => message.role === "tool");
		const lastUserText = textOf(parsed.data.messages[lastUserIndex]?.content);
		if (parsed.data.stream === true && (lastUserText.includes("[work]") || lastUserText.includes("[think]"))) {
			const step = parsed.data.messages.slice(lastUserIndex + 1).filter((m) => m.role === "tool").length;
			if (lastUserText.includes("[think]")) return workReply(0, true);
			if (step < 2) return workReply(step, false);
			reply = "verify-work: done";
		}
		if (lastUserText.includes("[sent-media]") && parsed.data.stream === true) {
			const step = parsed.data.messages.slice(lastUserIndex + 1).filter((m) => m.role === "tool").length;
			const path = "verify-sent-media.txt";
			if (step === 0) {
				return toolCallResponse("write_file", { path, content: "Verification file.\n" }, true);
			}
			if (step === 1 || step === 2) {
				return toolCallResponse(
					"send_file",
					{ path, caption: step === 1 ? "First copy." : "Second copy." },
					true,
					`call-verify-send-file-${step}`,
					step === 2 ? "Sending another copy." : undefined,
				);
			}
			reply = "verify-sent-media: sent both copies";
		}
		if (lastUserText.includes("[long]") && parsed.data.stream === true) {
			const toolsSinceUser = parsed.data.messages
				.slice(lastUserIndex + 1)
				.filter((message) => message.role === "tool").length;
			if (toolsSinceUser < 2) {
				await Bun.sleep(1000);
				return toolCallResponse(
					"read_file",
					{ path: "../state/goblin.log", offset: -(toolsSinceUser + 2) },
					true,
					`call-verify-long-${toolsSinceUser}`,
				);
			}
			return longReply();
		}
		if (!toolAfterLastUser) {
			const postMatch = /\[post ([^\]]*)\]/.exec(lastUserText);
			if (postMatch !== null) {
				return toolCallResponse("post", { text: postMatch[1]! }, parsed.data.stream === true);
			}
			const delegateMatch = /\[delegate (\S+) (\S+) ([^\]]+)\]/.exec(lastUserText);
			if (delegateMatch !== null) {
				return toolCallResponse(
					"delegate",
					{
						action: "start",
						harness: delegateMatch[1],
						cwd: delegateMatch[2],
						task: delegateMatch[3]!.trim(),
					},
					parsed.data.stream === true,
				);
			}
		}
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
		const hold = reply.includes("[hold]");
		if (hold) {
			// Headers sent, wire open, nothing ever comes — the request stays
			// pending until the client gives up (Stop) or the process dies.
			return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers });
		}
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
