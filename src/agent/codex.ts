// Codex provider kind: OpenAI's ChatGPT-subscription Codex backend
// (chatgpt.com/backend-api/codex/responses) as a LanguageModelV2 — the
// "thin custom provider over OAuth + the responses endpoint" DESIGN.md
// called for. ai-sdk-provider-codex-cli wraps the CLI's own agent loop
// (no caller tools), which can't drive goblin's turn loop.
//
// Auth is codex CLI's OAuth file (default ~/.codex/auth.json), read fresh
// per call so the CLI's own refreshes propagate. Expired access tokens are
// refreshed against the public OAuth endpoint and written back — refresh
// tokens rotate, so not writing back would invalidate the CLI's login.
//
// Effort mapping lives in providers.ts (thinkingOptions →
// providerOptions.codex.reasoningEffort).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
	LanguageModelV2CallWarning,
	LanguageModelV2Content,
	LanguageModelV2FinishReason,
	LanguageModelV2FunctionTool,
	LanguageModelV2Prompt,
	LanguageModelV2StreamPart,
	LanguageModelV2Usage,
} from "@ai-sdk/provider";
import { z } from "zod";
import { durableWriteFile } from "../durable.ts";
import { log } from "../log.ts";

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Codex CLI's public OAuth client id — published in the CLI source.
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
// Refresh a token this far ahead of its JWT exp — clock skew plus the
// duration of one request is comfortably covered.
const EXPIRY_MARGIN_S = 60;

// Injectable for tests — narrower than `typeof fetch`, which in Bun
// carries extra members (preconnect) a fake can't satisfy.
type FetchLike = (
	url: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

const authFileSchema = z.object({
	tokens: z.object({
		access_token: z.string().min(1),
		refresh_token: z.string().min(1).optional(),
		account_id: z.string().min(1).optional(),
	}),
});

const refreshResponseSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1).optional(),
	id_token: z.string().min(1).optional(),
});

export type CodexAuthFile = z.infer<typeof authFileSchema>;

// Read + parse the codex CLI auth file. ENOENT propagates as a pointed
// "run codex login" — the file is the only credential source.
function readAuthFile(path: string): CodexAuthFile {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`codex auth file not found at ${path} — run \`codex login\` first`);
		}
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${path}: not valid JSON — re-run \`codex login\``);
	}
	const result = authFileSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(`${path}: no usable tokens — re-run \`codex login\``);
	}
	return result.data;
}

// JWT exp claim without verification — it's our own credential's lifetime,
// not an authenticity check. Non-JWT tokens count as unexpired.
function tokenExpiryS(token: string): number | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		const payload = JSON.parse(
			Buffer.from(parts[1]!, "base64url").toString("utf8"),
		) as { exp?: number };
		return typeof payload.exp === "number" ? payload.exp : null;
	} catch {
		return null;
	}
}

// Fresh credentials for one request: file → expiry check → refresh.
// Exported for tests; the model calls it per request.
export async function codexCredentials(
	path: string,
	fetchImpl: FetchLike = fetch,
): Promise<CodexAuthFile> {
	const auth = readAuthFile(path);
	const exp = tokenExpiryS(auth.tokens.access_token);
	if (exp === null || exp - Date.now() / 1000 > EXPIRY_MARGIN_S) return auth;
	const res = await fetchImpl(OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_id: OAUTH_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: auth.tokens.refresh_token ?? "",
		}),
	});
	if (!res.ok) {
		throw new Error(
			`codex token refresh failed: HTTP ${res.status} — run \`codex login\` to re-authenticate`,
		);
	}
	const refreshed = refreshResponseSchema.parse(await res.json());
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		// file moved mid-flight — the write below restores a whole file
	}
	const tokens = {
		...auth.tokens,
		access_token: refreshed.access_token,
		refresh_token: refreshed.refresh_token ?? auth.tokens.refresh_token,
	};
	durableWriteFile(
		path,
		JSON.stringify(
			{
				...existing,
				tokens: { ...(existing.tokens as object | undefined), ...tokens },
				last_refresh: new Date().toISOString(),
			},
			null,
			2,
		) + "\n",
	);
	log.info("codex oauth token refreshed", { authFile: path });
	return { tokens };
}

// ---------- prompt → responses input ----------

type ResponsesInputItem = Record<string, unknown>;

function fileToDataUrl(data: unknown, mediaType: string): string {
	if (typeof data === "string") {
		// base64 payload or a URL — the SDK gives URLs as strings too.
		if (data.startsWith("http://") || data.startsWith("https://") || data.startsWith("data:")) {
			return data;
		}
		return `data:${mediaType};base64,${data}`;
	}
	if (data instanceof Uint8Array) {
		return `data:${mediaType};base64,${Buffer.from(data).toString("base64")}`;
	}
	if (data instanceof URL) return data.toString();
	throw new Error(`codex: unsupported file data shape (${typeof data})`);
}

function toolResultText(output: {
	type: string;
	value?: unknown;
}): string {
	if (output.type === "text" || output.type === "error-text") {
		return String(output.value ?? "");
	}
	if (output.type === "json" || output.type === "error-json") {
		return JSON.stringify(output.value);
	}
	if (output.type === "content" && Array.isArray(output.value)) {
		return (output.value as Array<{ type: string; text?: string }>)
			.filter((p) => p.type === "text")
			.map((p) => p.text ?? "")
			.join("\n");
	}
	return JSON.stringify(output.value ?? null);
}

// LanguageModelV2Prompt → responses `input` items + instructions.
// Assistant reasoning parts are dropped — the backend accepts no reasoning
// echo without the encrypted content we don't persist.
function convertPrompt(prompt: LanguageModelV2Prompt): {
	instructions: string | undefined;
	input: ResponsesInputItem[];
} {
	const instructions: string[] = [];
	const input: ResponsesInputItem[] = [];
	for (const msg of prompt) {
		switch (msg.role) {
			case "system":
				instructions.push(msg.content);
				break;
			case "user": {
				const content: unknown[] = [];
				for (const part of msg.content) {
					if (part.type === "text") {
						content.push({ type: "input_text", text: part.text });
					} else if (part.mediaType.startsWith("image/")) {
						content.push({
							type: "input_image",
							image_url: fileToDataUrl(part.data, part.mediaType),
						});
					} else if (part.mediaType === "application/pdf") {
						content.push({
							type: "input_file",
							filename: part.filename ?? "attachment.pdf",
							file_data: fileToDataUrl(part.data, part.mediaType),
						});
					} else {
						throw new Error(`codex: unsupported input media type "${part.mediaType}"`);
					}
				}
				input.push({ type: "message", role: "user", content });
				break;
			}
			case "assistant": {
				const content: unknown[] = [];
				for (const part of msg.content) {
					if (part.type === "text") {
						content.push({ type: "output_text", text: part.text });
					} else if (part.type === "tool-call") {
						if (content.length) {
							input.push({ type: "message", role: "assistant", content });
							content.length = 0;
						}
						input.push({
							type: "function_call",
							call_id: part.toolCallId,
							name: part.toolName,
							arguments: part.input,
						});
					}
					// reasoning/file/tool-result parts on assistant messages are
					// dropped — see the note above.
				}
				if (content.length) input.push({ type: "message", role: "assistant", content });
				break;
			}
			case "tool":
				for (const part of msg.content) {
					input.push({
						type: "function_call_output",
						call_id: part.toolCallId,
						output: toolResultText(part.output),
					});
				}
				break;
		}
	}
	return { instructions: instructions.join("\n\n") || undefined, input };
}

// ---------- SSE parsing ----------

// One parsed SSE frame: the JSON payload of a `data:` line.
async function* sseEvents(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let idx: number;
		while ((idx = buf.indexOf("\n\n")) !== -1) {
			const frame = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			for (const line of frame.split("\n")) {
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (data === "[DONE]") return;
				try {
					yield JSON.parse(data) as Record<string, unknown>;
				} catch {
					// A non-JSON data line is noise — keep consuming.
				}
			}
		}
	}
}

interface StreamState {
	textOpen: string | null;
	reasoningOpen: string | null;
	sawToolCall: boolean;
}

function mapEvent(
	event: Record<string, unknown>,
	state: StreamState,
	push: (p: LanguageModelV2StreamPart) => void,
): void {
	const type = event.type as string;
	const item = event.item as Record<string, unknown> | undefined;
	switch (type) {
		case "response.output_item.added":
			if (item?.type === "message") {
				state.textOpen = String(item.id ?? "text");
				push({ type: "text-start", id: state.textOpen });
			} else if (item?.type === "reasoning") {
				state.reasoningOpen = String(item.id ?? "reasoning");
				push({ type: "reasoning-start", id: state.reasoningOpen });
			}
			break;
		case "response.output_text.delta":
			if (state.textOpen) {
				push({ type: "text-delta", id: state.textOpen, delta: String(event.delta ?? "") });
			}
			break;
		case "response.reasoning_summary_text.delta":
		case "response.reasoning_text.delta":
			if (state.reasoningOpen) {
				push({
					type: "reasoning-delta",
					id: state.reasoningOpen,
					delta: String(event.delta ?? ""),
				});
			}
			break;
		case "response.output_item.done":
			if (item?.type === "function_call") {
				state.sawToolCall = true;
				push({
					type: "tool-call",
					toolCallId: String(item.call_id ?? item.id ?? ""),
					toolName: String(item.name ?? ""),
					input: String(item.arguments ?? "{}"),
				});
			} else if (item?.type === "message" && state.textOpen) {
				push({ type: "text-end", id: state.textOpen });
				state.textOpen = null;
			} else if (item?.type === "reasoning" && state.reasoningOpen) {
				push({ type: "reasoning-end", id: state.reasoningOpen });
				state.reasoningOpen = null;
			}
			break;
		case "response.completed":
		case "response.incomplete": {
			const response = event.response as Record<string, unknown> | undefined;
			const usage = (response?.usage ?? {}) as Record<string, unknown>;
			const outDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
			const inDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
			if (state.textOpen) {
				push({ type: "text-end", id: state.textOpen });
				state.textOpen = null;
			}
			if (state.reasoningOpen) {
				push({ type: "reasoning-end", id: state.reasoningOpen });
				state.reasoningOpen = null;
			}
			push({
				type: "finish",
				finishReason: finishReasonOf(state, response?.status),
				usage: {
					inputTokens: num(usage.input_tokens),
					outputTokens: num(usage.output_tokens),
					totalTokens: num(usage.total_tokens),
					reasoningTokens: num(outDetails.reasoning_tokens),
					cachedInputTokens: num(inDetails.cached_tokens),
				},
			});
			break;
		}
		case "response.failed":
		case "error": {
			const resp = event.response as Record<string, unknown> | undefined;
			push({
				type: "error",
				error: new Error(
					`codex stream ${type}: ${JSON.stringify(event.error ?? resp?.error ?? event)}`,
				),
			});
			break;
		}
	}
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function finishReasonOf(
	state: StreamState,
	status: unknown,
): LanguageModelV2FinishReason {
	if (state.sawToolCall) return "tool-calls";
	if (status === "incomplete") return "length";
	return "stop";
}

// ---------- the model ----------

interface CodexProviderOptions {
	reasoningEffort?: string;
}

export class CodexLanguageModel implements LanguageModelV2 {
	readonly specificationVersion = "v2" as const;
	readonly provider = "codex";
	readonly supportedUrls = {};

	constructor(
		readonly modelId: string,
		private readonly authFile: string,
		private readonly fetchImpl: FetchLike = fetch,
	) {}

	private async buildRequest(options: LanguageModelV2CallOptions): Promise<{
		body: Record<string, unknown>;
		headers: Record<string, string>;
	}> {
		const auth = await codexCredentials(this.authFile, this.fetchImpl);
		const { instructions, input } = convertPrompt(options.prompt);
		const codexOpts = (options.providerOptions?.codex ?? {}) as CodexProviderOptions;
		const body: Record<string, unknown> = {
			model: this.modelId,
			instructions: instructions ?? "",
			input,
			store: false,
			stream: true,
			include: ["reasoning.encrypted_content"],
		};
		if (codexOpts.reasoningEffort) {
			body.reasoning = { effort: codexOpts.reasoningEffort, summary: "auto" };
		}
		if (options.tools?.length) {
			const fns = options.tools.filter(
				(t): t is LanguageModelV2FunctionTool => t.type === "function",
			);
			body.tools = fns.map((t) => ({
				type: "function",
				name: t.name,
				description: t.description,
				parameters: t.inputSchema,
				strict: false,
			}));
		}
		if (options.toolChoice) {
			body.tool_choice =
				options.toolChoice.type === "tool"
					? { type: "function", name: options.toolChoice.toolName }
					: options.toolChoice.type;
		}
		return {
			body,
			headers: {
				authorization: `Bearer ${auth.tokens.access_token}`,
				"content-type": "application/json",
				...(auth.tokens.account_id
					? { "chatgpt-account-id": auth.tokens.account_id }
					: {}),
				"OpenAI-Beta": "responses=experimental",
				originator: "codex_cli_rs",
				accept: "text/event-stream",
			},
		};
	}

	private warningsFor(options: LanguageModelV2CallOptions): LanguageModelV2CallWarning[] {
		const warnings: LanguageModelV2CallWarning[] = [];
		for (const k of [
			"maxOutputTokens",
			"temperature",
			"topP",
			"topK",
			"presencePenalty",
			"frequencyPenalty",
			"stopSequences",
			"seed",
			"responseFormat",
		] as const) {
			if (options[k] !== undefined) warnings.push({ type: "unsupported-setting", setting: k });
		}
		if (options.tools?.some((t) => t.type !== "function")) {
			warnings.push({
				type: "unsupported-setting",
				setting: "tools",
				details: "provider-defined tools are not supported by codex",
			});
		}
		return warnings;
	}

	private async post(body: Record<string, unknown>, headers: Record<string, string>, signal?: AbortSignal) {
		const res = await this.fetchImpl(RESPONSES_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: signal ?? null,
		});
		if (!res.ok || !res.body) {
			const detail = await res.text().catch(() => "");
			throw new Error(`codex responses HTTP ${res.status}: ${detail.slice(0, 500)}`);
		}
		return res;
	}

	async doStream(options: LanguageModelV2CallOptions): Promise<{
		stream: ReadableStream<LanguageModelV2StreamPart>;
		request: { body: unknown };
	}> {
		const { body, headers } = await this.buildRequest(options);
		const res = await this.post(body, headers, options.abortSignal);
		const warnings = this.warningsFor(options);
		const state: StreamState = { textOpen: null, reasoningOpen: null, sawToolCall: false };
		const stream = new ReadableStream<LanguageModelV2StreamPart>({
			start: (controller) => {
				push({ type: "stream-start", warnings });
				void (async () => {
					try {
						for await (const event of sseEvents(res.body!)) {
							mapEvent(event, state, push);
						}
					} catch (err) {
						push({ type: "error", error: err });
					} finally {
						controller.close();
					}
				})();
				function push(part: LanguageModelV2StreamPart): void {
					controller.enqueue(part);
				}
			},
		});
		return { stream, request: { body } };
	}

	async doGenerate(options: LanguageModelV2CallOptions): Promise<{
		content: LanguageModelV2Content[];
		finishReason: LanguageModelV2FinishReason;
		usage: LanguageModelV2Usage;
		warnings: LanguageModelV2CallWarning[];
		request: { body: unknown };
	}> {
		const { stream, request } = await this.doStream(options);
		const content: LanguageModelV2Content[] = [];
		const textBuf = new Map<string, string>();
		const reasoningBuf = new Map<string, string>();
		let finishReason: LanguageModelV2FinishReason = "unknown";
		let usage: LanguageModelV2Usage = {
			inputTokens: undefined,
			outputTokens: undefined,
			totalTokens: undefined,
		};
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			switch (value.type) {
				case "text-delta":
					textBuf.set(value.id, (textBuf.get(value.id) ?? "") + value.delta);
					break;
				case "reasoning-delta":
					reasoningBuf.set(value.id, (reasoningBuf.get(value.id) ?? "") + value.delta);
					break;
				case "tool-call":
					content.push({
						type: "tool-call",
						toolCallId: value.toolCallId,
						toolName: value.toolName,
						input: value.input,
					});
					break;
				case "finish":
					finishReason = value.finishReason;
					usage = value.usage;
					break;
				case "error":
					throw value.error;
			}
		}
		// Reasoning precedes text in the emitted content — matches how the
		// SDK lays out multi-part assistant output.
		return {
			content: [
				...[...reasoningBuf.values()].map(
					(text): LanguageModelV2Content => ({ type: "reasoning", text }),
				),
				...[...textBuf.values()].map(
					(text): LanguageModelV2Content => ({ type: "text", text }),
				),
				...content,
			],
			finishReason,
			usage,
			warnings: this.warningsFor(options),
			request,
		};
	}
}

export function codexModel(
	modelId: string,
	authFile?: string,
	fetchImpl: FetchLike = fetch,
): CodexLanguageModel {
	return new CodexLanguageModel(
		modelId,
		authFile ?? join(homedir(), ".codex", "auth.json"),
		fetchImpl,
	);
}

export function defaultCodexAuthFile(): string {
	return join(homedir(), ".codex", "auth.json");
}
