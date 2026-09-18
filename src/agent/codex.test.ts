// The codex provider's boundaries: OAuth refresh must write rotated
// refresh tokens back (not writing back invalidates the CLI's login),
// and the request body must be a real responses-API shape — prompt
// conversion and effort placement are the contract codex.ts exists for.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexLanguageModel, codexCredentials } from "./codex.ts";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (exp: number) => `${b64({ alg: "none" })}.${b64({ exp })}.sig`;

function authDir(tokens: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-codex-"));
	const path = join(dir, "auth.json");
	writeFileSync(path, JSON.stringify({ tokens, ...extra }));
	return path;
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

describe("codexCredentials — oauth refresh write-back", () => {
	test("an unexpired token is used as-is, no refresh call", async () => {
		const path = authDir({ access_token: jwt(FUTURE), refresh_token: "rt" });
		const auth = await codexCredentials(path, () => {
			throw new Error("fetch must not fire for a fresh token");
		});
		expect(auth.tokens.access_token).toContain(".");
	});

	test("expired token refreshes and the rotated refresh token is persisted", async () => {
		const path = authDir(
			{ access_token: jwt(PAST), refresh_token: "old-rt", account_id: "acc-1" },
			{ last_refresh: "2026-01-01T00:00:00Z", auth_mode: "chatgpt" },
		);
		const seen: { url?: string; body?: string } = {};
		const auth = await codexCredentials(path, async (url, init) => {
			seen.url = String(url);
			seen.body = String(init?.body);
			return new Response(
				JSON.stringify({ access_token: jwt(FUTURE), refresh_token: "new-rt" }),
			);
		});
		expect(seen.url).toContain("oauth/token");
		expect(JSON.parse(seen.body!)).toMatchObject({
			grant_type: "refresh_token",
			refresh_token: "old-rt",
		});
		expect(auth.tokens.refresh_token).toBe("new-rt");
		const onDisk = JSON.parse(readFileSync(path, "utf8"));
		// The rotated pair must be on disk — a refresh token is single-use,
		// losing it logs the CLI out. Unrelated file fields survive.
		expect(onDisk.tokens.refresh_token).toBe("new-rt");
		expect(onDisk.tokens.account_id).toBe("acc-1");
		expect(onDisk.auth_mode).toBe("chatgpt");
	});

	test("a failed refresh points at re-login, not a silent retry", async () => {
		const path = authDir({ access_token: jwt(PAST), refresh_token: "rt" });
		await expect(
			codexCredentials(path, async () => new Response("nope", { status: 401 })),
		).rejects.toThrow("codex login");
	});

	test("missing file says so plainly", async () => {
		await expect(codexCredentials(join(tmpdir(), "no-such-auth.json"))).rejects.toThrow(
			"codex auth file not found",
		);
	});
});

describe("CodexLanguageModel — request shape", () => {
	function sse(frames: Record<string, unknown>[]): Response {
		const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
		return new Response(new TextEncoder().encode(body));
	}

	test("prompt converts to responses input; effort lands on reasoning.effort", async () => {
		const path = authDir({ access_token: jwt(FUTURE) });
		let sent: Record<string, unknown> = {};
		const model = new CodexLanguageModel("gpt-6-astra", path, async (_url, init) => {
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sse([
				{
					type: "response.completed",
					response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
				},
			]);
		});
		const result = await model.doGenerate({
			prompt: [
				{ role: "system", content: "be terse" },
				{ role: "user", content: [{ type: "text", text: "hi" }] },
			],
			providerOptions: { codex: { reasoningEffort: "xhigh" } },
		});
		expect(sent.model).toBe("gpt-6-astra");
		expect(sent.instructions).toBe("be terse");
		expect(sent.store).toBe(false);
		expect(sent.stream).toBe(true);
		expect(sent.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
		const input = sent.input as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
		expect(input[0]!.role).toBe("user");
		expect(input[0]!.content[0]).toEqual({ type: "input_text", text: "hi" });
		expect(result.finishReason).toBe("stop");
		expect(result.usage.inputTokens).toBe(5);
	});

	test("a tool result round-trips as function_call_output", async () => {
		const path = authDir({ access_token: jwt(FUTURE) });
		let sent: Record<string, unknown> = {};
		const model = new CodexLanguageModel("gpt-6-astra", path, async (_url, init) => {
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sse([
				{
					type: "response.completed",
					response: { status: "completed", usage: {} },
				},
			]);
		});
		await model.doGenerate({
			prompt: [
				{ role: "user", content: [{ type: "text", text: "run ls" }] },
				{
					role: "assistant",
					content: [
						{ type: "tool-call", toolCallId: "call_1", toolName: "bash", input: '{"command":"ls"}' },
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "call_1",
							toolName: "bash",
							output: { type: "text", value: "file.txt" },
						},
					],
				},
			],
		});
		const input = sent.input as Array<Record<string, unknown>>;
		expect(input[1]).toMatchObject({ type: "function_call", call_id: "call_1", name: "bash" });
		expect(input[2]).toEqual({
			type: "function_call_output",
			call_id: "call_1",
			output: "file.txt",
		});
	});
});
