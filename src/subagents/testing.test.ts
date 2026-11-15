import { describe, expect, test } from "bun:test";
import { setLogFile } from "../log.ts";
import { servers, startFakeModel, type FakeModel } from "./testing.ts";

setLogFile(null);

function post(model: FakeModel, messages: { role: string; content: unknown }[]): Promise<Response> {
	return fetch(model.url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messages }),
	});
}

async function replyText(res: Response): Promise<string> {
	const body = await res.text();
	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
		const chunk = JSON.parse(line.slice("data: ".length)) as {
			choices?: { delta?: { content?: string } }[];
		};
		const content = chunk.choices?.[0]?.delta?.content;
		if (typeof content === "string" && content !== "") return content;
	}
	return "";
}

describe("fake model matched replies", () => {
	test("a non-matching request does not consume a matched reply; a matching one does", async () => {
		const model = startFakeModel();
		servers.push(model);
		model.push({ kind: "text", text: "reserved for recovery" }, "[goblin]");
		// The abort-raced first generation: the last user message is the task text.
		expect(await replyText(await post(model, [{ role: "user", content: "do the task" }]))).toBe(
			"unscripted reply",
		);
		// The recovery round: the [goblin] nudge is the last user message.
		expect(
			await replyText(await post(model, [{ role: "user", content: "[goblin] continue the task" }])),
		).toBe("reserved for recovery");
	});

	test("matched replies keep FIFO order among matching requests", async () => {
		const model = startFakeModel();
		servers.push(model);
		model.push({ kind: "text", text: "first" }, "[goblin]");
		model.push({ kind: "text", text: "second" }, "[goblin]");
		expect(await replyText(await post(model, [{ role: "user", content: "[goblin] a" }]))).toBe(
			"first",
		);
		expect(await replyText(await post(model, [{ role: "user", content: "[goblin] b" }]))).toBe(
			"second",
		);
	});

	test("a non-matching request leaves the whole queue untouched, matcher-less replies included", async () => {
		const model = startFakeModel();
		servers.push(model);
		model.push({ kind: "text", text: "reserved" }, "[goblin]");
		model.push({ kind: "text", text: "plain" });
		expect(await replyText(await post(model, [{ role: "user", content: "other task" }]))).toBe(
			"unscripted reply",
		);
		expect(await replyText(await post(model, [{ role: "user", content: "[goblin] x" }]))).toBe(
			"reserved",
		);
		expect(await replyText(await post(model, [{ role: "user", content: "anything" }]))).toBe(
			"plain",
		);
	});

	test("the match scans back to the last user/tool message past a trailing assistant message", async () => {
		const model = startFakeModel();
		servers.push(model);
		model.push({ kind: "text", text: "reserved" }, "[goblin]");
		expect(
			await replyText(
				await post(model, [
					{ role: "user", content: "[goblin] continue" },
					{ role: "assistant", content: "working" },
				]),
			),
		).toBe("reserved");
	});
});
