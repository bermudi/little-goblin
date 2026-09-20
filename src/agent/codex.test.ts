// The codex provider's boundaries: OAuth refresh must write rotated
// refresh tokens back (not writing back invalidates the CLI's login),
// and the request body must be a real responses-API shape — prompt
// conversion and effort placement are the contract codex.ts exists for.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

	test("a lost refresh race adopts the sibling's fresh pair instead of demanding re-login", async () => {
		const path = authDir({ access_token: jwt(PAST), refresh_token: "rt" });
		const cliFresh = jwt(FUTURE);
		const auth = await codexCredentials(path, async () => {
			// The CLI refreshed the same single-use token and won: its pair
			// is on disk by the time our POST fails with invalid_grant.
			writeFileSync(
				path,
				JSON.stringify({ tokens: { access_token: cliFresh, refresh_token: "cli-rt" } }),
			);
			return new Response("invalid_grant", { status: 400 });
		});
		expect(auth.tokens.access_token).toBe(cliFresh);
		expect(auth.tokens.refresh_token).toBe("cli-rt");
	});

	test("a merge read that stays unreadable still persists the rotated pair — loudly", async () => {
		const path = authDir(
			{ access_token: jwt(PAST), refresh_token: "old-rt" },
			{ last_refresh: "2026-01-01T00:00:00Z", auth_mode: "chatgpt" },
		);
		// Owner-unreadable from the POST onward: the merge read fails EACCES
		// through all retries. The write must still happen — the refresh
		// token is single-use and losing it logs the CLI out.
		try {
			const auth = await codexCredentials(path, async () => {
				chmodSync(path, 0o000);
				return new Response(
					JSON.stringify({ access_token: jwt(FUTURE), refresh_token: "new-rt" }),
				);
			});
			expect(auth.tokens.refresh_token).toBe("new-rt");
		} finally {
			chmodSync(path, 0o644);
		}
		const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
			tokens: { refresh_token: string };
			auth_mode?: string;
		};
		expect(onDisk.tokens.refresh_token).toBe("new-rt");
		// Sibling fields drop in this path — that's the warned trade-off,
		// not a silent clobber; the warn line names the file.
		expect(onDisk.auth_mode).toBeUndefined();
	});

	test("missing file says so plainly", async () => {
		await expect(codexCredentials(join(tmpdir(), "no-such-auth.json"))).rejects.toThrow(
			"codex auth file not found",
		);
	});

	test("concurrent callers share one refresh — the token is single-use", async () => {
		const path = authDir({ access_token: jwt(PAST), refresh_token: "rt" });
		let fetches = 0;
		let resolveFetch!: (r: Response) => void;
		const gate = new Promise<Response>((r) => {
			resolveFetch = r;
		});
		const p1 = codexCredentials(path, async () => {
			fetches++;
			return gate;
		});
		const p2 = codexCredentials(path, async () => {
			fetches++;
			return gate;
		});
		await Bun.sleep(0); // let both callers reach the inflight check
		resolveFetch(
			new Response(
				JSON.stringify({ access_token: jwt(FUTURE), refresh_token: "rt2" }),
			),
		);
		const [a, b] = await Promise.all([p1, p2]);
		// Two overlapping turns must not both POST the single-use token.
		expect(fetches).toBe(1);
		expect(a.tokens.access_token).toBe(b.tokens.access_token);
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

	test("stream events map to parts — deltas, done-item fallback, tool calls", async () => {
		const path = authDir({ access_token: jwt(FUTURE) });
		const model = new CodexLanguageModel("gpt-6-astra", path, async () =>
			sse([
				{ type: "response.output_item.added", item: { type: "reasoning", id: "r1" } },
				{ type: "response.reasoning_summary_text.delta", delta: "thinking…" },
				// A message that arrives only in done — no added/delta stream —
				// must still emit its content, not vanish.
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "m1",
						content: [{ type: "output_text", text: "the answer" }],
					},
				},
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "f1",
						call_id: "call_1",
						name: "bash",
						arguments: "{}",
					},
				},
				{ type: "response.completed", response: { status: "completed", usage: {} } },
			]),
		);
		const r = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		});
		expect(r.finishReason).toBe("tool-calls");
		expect(r.content.map((c) => c.type)).toEqual(["reasoning", "text", "tool-call"]);
		expect((r.content[0] as { text: string }).text).toBe("thinking…");
		expect((r.content[1] as { text: string }).text).toBe("the answer");
	});
});
