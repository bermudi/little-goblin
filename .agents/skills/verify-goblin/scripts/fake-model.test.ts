import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { tmpDir } from "../../../../src/testkit.ts";

async function withFakeServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
	const dir = tmpDir("verify-fake-model-");
	const portFile = join(dir, "port");
	const server = Bun.spawn(
		["bun", "--no-env-file", join(import.meta.dir, "fake-model.ts"), portFile],
		{ stdout: "ignore", stderr: "ignore" },
	);
	try {
		let port: number | null = null;
		for (let attempt = 0; attempt < 200; attempt += 1) {
			if (existsSync(portFile)) {
				port = Number(readFileSync(portFile, "utf8"));
				break;
			}
			await Bun.sleep(10);
		}
		if (port === null || !Number.isSafeInteger(port) || port < 1)
			throw new Error("fake model did not publish its port");
		return await run(`http://127.0.0.1:${port}`);
	} finally {
		server.kill("SIGTERM");
		await server.exited;
	}
}

async function modelCall(baseUrl: string, message: string) {
	const response = await fetch(`${baseUrl}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ stream: false, messages: [{ role: "user", content: message }] }),
	});
	return response.json() as Promise<{
		choices: {
			message: {
				content?: string | null;
				tool_calls?: { function: { name: string; arguments: string } }[];
			};
		}[];
	}>;
}

test("fake model markers call ask open and close with app time suffixes", async () => {
	await withFakeServer(async (baseUrl) => {
		const suffix = "[2026-11-26 14:53 -06:00 · app]";
		const opened = await modelCall(baseUrl, `[ask When should the nudge fire?|9:00|11:00]${suffix}`);
		const openCall = opened.choices[0]?.message.tool_calls?.[0];
		expect(openCall?.function.name).toBe("ask");
		expect(JSON.parse(openCall!.function.arguments)).toEqual({
			action: "open",
			question: "When should the nudge fire?",
			options: ["9:00", "11:00"],
		});
		const closed = await modelCall(baseUrl, `[ask-close 17]${suffix}`);
		const closeCall = closed.choices[0]?.message.tool_calls?.[0];
		expect(closeCall?.function.name).toBe("ask");
		expect(JSON.parse(closeCall!.function.arguments)).toEqual({ action: "close", id: 17 });
	});
});

test("fake model does not treat an ask tap message as an open marker", async () => {
	await withFakeServer(async (baseUrl) => {
		const response = await modelCall(baseUrl, "[ask] Q → 9:00[2026-11-26 14:53 -06:00 · app]");
		expect(response.choices[0]?.message.tool_calls).toBeUndefined();
		expect(response.choices[0]?.message.content).toContain("verify-reply:");
	});
});

test("fake System1 endpoint scores the exact serialized checkState shape", async () => {
	await withFakeServer(async (baseUrl) => {
		const request = (next: string) =>
			fetch(`${baseUrl}/api/alpha/decisions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "fake-decision-model",
					state: JSON.stringify({ next }),
					questions: {
						follow_up: {
							type: "noul",
							instructions: "Check whether it follows up.",
							criteria: { true: "Same subject.", false: "New subject." },
						},
					},
				}),
			});
		const fresh = await request("[new topic] another subject");
		expect(fresh.status).toBe(200);
		expect(await fresh.json()).toEqual({
			answers: { follow_up: { type: "noul", noul: 0.05 } },
		});
		const continuation = await request("and one more detail");
		expect(continuation.status).toBe(200);
		expect(await continuation.json()).toEqual({
			answers: { follow_up: { type: "noul", noul: 0.9 } },
		});
	});
});

test("fake System1 endpoint rejects a non-string or malformed state", async () => {
	await withFakeServer(async (baseUrl) => {
		const invalid = await fetch(`${baseUrl}/api/alpha/decisions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "fake", state: { next: "[new topic]" }, questions: {} }),
		});
		expect(invalid.status).toBe(400);
		const malformed = await fetch(`${baseUrl}/api/alpha/decisions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "fake", state: "{", questions: {} }),
		});
		expect(malformed.status).toBe(400);
	});
});

test("fake model pass_fill marker calls the tool then replies with its result", async () => {
        await withFakeServer(async (baseUrl) => {
                const suffix = "[2026-11-26 14:53 -06:00 · app]";
                const first = await modelCall(baseUrl, `[pass_fill pass://S/I/password #pw work]${suffix}`);
                const call = first.choices[0]?.message.tool_calls?.[0];
                expect(call?.function.name).toBe("pass_fill");
                expect(JSON.parse(call!.function.arguments)).toEqual({
                        ref: "pass://S/I/password",
                        target: "#pw",
                        session: "work",
                });
                const bare = await modelCall(baseUrl, `[pass_fill pass://S/I/password #pw]${suffix}`);
                expect(JSON.parse(bare.choices[0]!.message.tool_calls![0]!.function.arguments)).toEqual({
                        ref: "pass://S/I/password",
                        target: "#pw",
                });
                const toolCall = {
                        id: "call-verify-pass_fill",
                        type: "function",
                        function: { name: "pass_fill", arguments: JSON.stringify({ ref: "pass://S/I/password", target: "#pw" }) },
                };
                const second = await fetch(`${baseUrl}/v1/chat/completions`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                                stream: false,
                                messages: [
                                        { role: "user", content: `[pass_fill pass://S/I/password #pw]${suffix}` },
                                        { role: "assistant", content: null, tool_calls: [toolCall] },
                                        {
                                                role: "tool",
                                                tool_call_id: "call-verify-pass_fill",
                                                content: JSON.stringify({ type: "json", value: { filled: true, field: "password", host: "127.0.0.1" } }),
                                        },
                                ],
                        }),
                });
                const body = (await second.json()) as { choices: { message: { content?: string } }[] };
                expect(body.choices[0]?.message.content).toContain("verify-reply: pass_fill ");
                expect(body.choices[0]?.message.content).toContain('"filled":true');
        });
});
