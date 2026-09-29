// Codex provider kind: OpenAI's ChatGPT-subscription Codex backend
// (chatgpt.com/backend-api/codex/responses) as a LanguageModelV4 — the
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
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4Content,
	LanguageModelV4FinishReason,
	LanguageModelV4FunctionTool,
	LanguageModelV4Prompt,
	LanguageModelV4StreamPart,
	LanguageModelV4Usage,
	SharedV4FileData,
	SharedV4Warning,
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

// Refresh tokens are single-use — two callers POSTing the same one
// concurrently loses one to invalid_grant and a false "run codex login".
// Single-flight per auth file; concurrent conversations share it.
const refreshInflight = new Map<string, Promise<CodexAuthFile>>();

function expired(token: string): boolean {
	const exp = tokenExpiryS(token);
	return exp !== null && exp - Date.now() / 1000 <= EXPIRY_MARGIN_S;
}

// Fresh credentials for one request: file → expiry check → refresh.
// Exported for tests; the model calls it per request.
export async function codexCredentials(
	path: string,
	fetchImpl: FetchLike = fetch,
): Promise<CodexAuthFile> {
	const auth = readAuthFile(path);
	if (!expired(auth.tokens.access_token)) return auth;
	let p = refreshInflight.get(path);
	if (!p) {
		// The flight is shared — no caller's abort signal may reach it,
		// or one turn's /stop fails every waiter's refresh.
		p = refreshAuth(path, fetchImpl).finally(() => {
			refreshInflight.delete(path);
		});
		refreshInflight.set(path, p);
	}
	return p;
}

async function refreshAuth(
	path: string,
	fetchImpl: FetchLike,
): Promise<CodexAuthFile> {
	// Re-read inside the flight — a sibling refresh (ours or the CLI's)
	// may already have rotated the pair while this caller queued.
	const auth = readAuthFile(path);
	if (!expired(auth.tokens.access_token)) return auth;
	if (!auth.tokens.refresh_token) {
		throw new Error(
			`${path}: access token expired and no refresh_token — run \`codex login\``,
		);
	}
	const res = await fetchImpl(OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_id: OAUTH_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: auth.tokens.refresh_token,
		}),
		// Hard deadline only — a wedged auth host must not park every
		// caller sharing this flight past the OS tcp timeout.
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) {
		// A 400 here is often a lost race, not a dead login: the codex CLI
		// (or any sibling) consumed the same single-use refresh token and
		// already wrote a fresh pair. Adopt it instead of demanding a
		// re-login that would fix nothing.
		try {
			const raced = readAuthFile(path);
			if (!expired(raced.tokens.access_token)) {
				log.info("codex refresh lost a race — adopted the sibling's fresh tokens", {
					authFile: path,
				});
				return raced;
			}
		} catch {
			// Unreadable now — the refresh failure below is the honest error.
		}
		throw new Error(
			`codex token refresh failed: HTTP ${res.status} — run \`codex login\` to re-authenticate`,
		);
	}
	const refreshed = refreshResponseSchema.parse(await res.json());
	let existing: Record<string, unknown> = {};
	// The merge read must survive a transient failure or a concurrent
	// non-atomic writer: retry briefly. Still failing → write anyway (the
	// new refresh token is single-use; losing it logs the CLI out), but
	// warn — sibling fields would drop out of the file.
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			break;
		} catch (err) {
			if (attempt === 2) {
				log.warn("codex auth re-read failed — writing tokens without sibling fields", {
					authFile: path,
					error: String(err),
				});
			} else {
				await Bun.sleep(50);
			}
		}
	}
	const tokens = {
		...auth.tokens,
		access_token: refreshed.access_token,
		refresh_token: refreshed.refresh_token ?? auth.tokens.refresh_token,
		...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
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
		// Live OAuth credentials — match the CLI's file mode on recreate.
		0o600,
	);
	log.info("codex oauth token refreshed", { authFile: path });
	return { tokens };
}

// ---------- prompt → responses input ----------

type ResponsesInputItem = Record<string, unknown>;

function fileToDataUrl(data: SharedV4FileData, mediaType: string): string {
	// Spec v4 tags the payload — no more guessing whether a string is a
	// URL, base64, or an inline data URL.
	if (data.type === "url") {
		return data.originalUrl ?? data.url.toString();
	}
	if (data.type === "reference") {
		throw new Error("codex: provider file references are not supported");
	}
	if (data.type === "text") {
		return `data:${mediaType};base64,${Buffer.from(data.text, "utf8").toString("base64")}`;
	}
	// 'data': raw bytes or base64 string. A data: string rides through
	// untouched rather than double-encoding a middleware's gift.
	if (typeof data.data === "string") {
		return data.data.startsWith("data:") ? data.data : `data:${mediaType};base64,${data.data}`;
	}
	return `data:${mediaType};base64,${Buffer.from(data.data).toString("base64")}`;
}

function toolResultText(output: {
	type: string;
	value?: unknown;
	reason?: unknown;
}): string {
	if (output.type === "text" || output.type === "error-text") {
		return String(output.value ?? "");
	}
	if (output.type === "json" || output.type === "error-json") {
		return JSON.stringify(output.value);
	}
	if (output.type === "execution-denied") {
		return typeof output.reason === "string" && output.reason
			? `[execution denied: ${output.reason}]`
			: "[execution denied]";
	}
	if (output.type === "content" && Array.isArray(output.value)) {
		return (output.value as Array<{ type: string; text?: string }>)
			.filter((p) => p.type === "text")
			.map((p) => p.text ?? "")
			.join("\n");
	}
	return JSON.stringify(output.value ?? null);
}

// LanguageModelV4Prompt → responses `input` items + instructions.
// Assistant reasoning parts are dropped — the backend accepts no reasoning
// echo without the encrypted content we don't persist.
function convertPrompt(prompt: LanguageModelV4Prompt): {
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
					} else if (
						part.mediaType === "image" ||
						part.mediaType.startsWith("image/")
					) {
						content.push({
							type: "input_image",
							image_url: fileToDataUrl(part.data, part.mediaType),
						});
					} else if (part.mediaType === "application/pdf") {
						const data = fileToDataUrl(part.data, part.mediaType);
						// Remote URLs go on file_url — file_data is the inline form.
						content.push(
							data.startsWith("http")
								? {
										type: "input_file",
										filename: part.filename ?? "attachment.pdf",
										file_url: data,
									}
								: {
										type: "input_file",
										filename: part.filename ?? "attachment.pdf",
										file_data: data,
									},
						);
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
					//
					// (Spec v4 also allows tool-result parts on assistant messages
					// for provider-executed tools — codex never requests any, so
					// dropping is the honest mapping.)
				}
				if (content.length) input.push({ type: "message", role: "assistant", content });
				break;
			}
			case "tool":
				for (const part of msg.content) {
					// Spec v4 unions approval responses into tool messages.
					// Codex never requests approvals, so a response part can't
					// legitimately arrive — skipping (not throwing) keeps a
					// midflight SDK change from killing the turn.
					if (part.type !== "tool-result") continue;
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

// One parsed SSE frame: the joined `data:` lines of an event block.
async function* sseEvents(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		// Normalize CRLF — a proxy folding line endings must not wedge the
		// frame scan (every event would sit buffered until the body ended).
		// Whole-buffer replace so a \r\n split across chunks still folds.
		buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
		let idx: number;
		while ((idx = buf.indexOf("\n\n")) !== -1) {
			const frame = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			// A frame may carry several data: lines — join per the SSE spec.
			// event:/id:/comment lines drop.
			const data = frame
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trimStart())
				.join("\n");
			if (!data) continue;
			if (data === "[DONE]") return;
			try {
				yield JSON.parse(data) as Record<string, unknown>;
			} catch {
				throw new Error("codex stream contained a malformed SSE data frame");
			}
		}
	}
}

interface StreamState {
	textOpen: string | null;
	reasoningOpen: string | null;
	sawToolCall: boolean;
	sawTerminal: boolean;
}

function mapEvent(
	event: Record<string, unknown>,
	state: StreamState,
	push: (p: LanguageModelV4StreamPart) => void,
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
			} else if (item?.type === "message") {
				if (state.textOpen) {
					push({ type: "text-end", id: state.textOpen });
					state.textOpen = null;
				} else {
					// A completed item with no added/delta stream — emit its
					// content rather than dropping the answer.
					const text = itemText(item, "content", "output_text");
					if (text) {
						const id = String(item.id ?? "text");
						push({ type: "text-start", id });
						push({ type: "text-delta", id, delta: text });
						push({ type: "text-end", id });
					}
				}
			} else if (item?.type === "reasoning") {
				if (state.reasoningOpen) {
					push({ type: "reasoning-end", id: state.reasoningOpen });
					state.reasoningOpen = null;
				} else {
					const text = itemText(item, "summary", "summary_text");
					if (text) {
						const id = String(item.id ?? "reasoning");
						push({ type: "reasoning-start", id });
						push({ type: "reasoning-delta", id, delta: text });
						push({ type: "reasoning-end", id });
					}
				}
			}
			break;
		case "response.completed":
		case "response.incomplete": {
			state.sawTerminal = true;
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
				// Spec v4 nests token counts: input/output objects with detail
				// splits, not flat numbers.
				usage: {
					inputTokens: {
						total: num(usage.input_tokens),
						noCache: undefined,
						cacheRead: num(inDetails.cached_tokens),
						cacheWrite: undefined,
					},
					outputTokens: {
						total: num(usage.output_tokens),
						text: undefined,
						reasoning: num(outDetails.reasoning_tokens),
					},
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

// Text payload of a completed item — message.content[] output_text or
// reasoning.summary[] summary_text. Wire-shaped, so fish out what's there.
function itemText(
	item: Record<string, unknown>,
	field: "content" | "summary",
	partType: string,
): string {
	const parts = item[field];
	if (!Array.isArray(parts)) return "";
	return parts
		.filter(
			(p): p is { type: string; text?: unknown } =>
				typeof p === "object" && p !== null &&
				(p as { type?: unknown }).type === partType,
		)
		.map((p) => String(p.text ?? ""))
		.join("");
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function finishReasonOf(
	state: StreamState,
	status: unknown,
): LanguageModelV4FinishReason {
	// Spec v4 pairs the unified reason with the provider's raw string.
	if (state.sawToolCall) return { unified: "tool-calls", raw: rawStatus(status) };
	if (status === "incomplete") return { unified: "length", raw: rawStatus(status) };
	return { unified: "stop", raw: rawStatus(status) };
}

function rawStatus(status: unknown): string | undefined {
	return typeof status === "string" ? status : undefined;
}

// ---------- the model ----------

interface CodexProviderOptions {
	reasoningEffort?: string;
}

export class CodexLanguageModel implements LanguageModelV4 {
	readonly specificationVersion = "v4" as const;
	readonly provider = "codex";
	readonly supportedUrls = {};

	constructor(
		readonly modelId: string,
		private readonly authFile: string,
		private readonly fetchImpl: FetchLike = fetch,
	) {}

	private async buildRequest(options: LanguageModelV4CallOptions): Promise<{
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
				(t): t is LanguageModelV4FunctionTool => t.type === "function",
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

	private warningsFor(options: LanguageModelV4CallOptions): SharedV4Warning[] {
		const warnings: SharedV4Warning[] = [];
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
			// Spec v4 collapsed unsupported-setting/unsupported-tool into a
			// single `unsupported` warning keyed by feature string.
			if (options[k] !== undefined) warnings.push({ type: "unsupported", feature: k });
		}
		for (const t of options.tools ?? []) {
			if (t.type !== "function") {
				warnings.push({
					type: "unsupported",
					feature: "provider-defined tools",
					details: "provider-defined tools are not supported by codex",
				});
			}
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

	async doStream(options: LanguageModelV4CallOptions): Promise<{
		stream: ReadableStream<LanguageModelV4StreamPart>;
		request: { body: unknown };
	}> {
		const { body, headers } = await this.buildRequest(options);
		const res = await this.post(body, headers, options.abortSignal);
		const warnings = this.warningsFor(options);
		const state: StreamState = { textOpen: null, reasoningOpen: null, sawToolCall: false, sawTerminal: false };
		let cancelled = false;
		const stream = new ReadableStream<LanguageModelV4StreamPart>({
			start: (controller) => {
				const push = (part: LanguageModelV4StreamPart): void => {
					if (!cancelled) controller.enqueue(part);
				};
				push({ type: "stream-start", warnings });
				void (async () => {
					try {
						for await (const event of sseEvents(res.body!)) {
							mapEvent(event, state, push);
						}
						if (!state.sawTerminal && !cancelled) {
							throw new Error("codex stream ended before a terminal response");
						}
					} catch (err) {
						push({ type: "error", error: err });
					} finally {
						if (!cancelled) controller.close();
					}
				})();
			},
			cancel: () => {
				cancelled = true;
				void res.body?.cancel();
			},
		});
		return { stream, request: { body } };
	}

	async doGenerate(options: LanguageModelV4CallOptions): Promise<{
		content: LanguageModelV4Content[];
		finishReason: LanguageModelV4FinishReason;
		usage: LanguageModelV4Usage;
		warnings: SharedV4Warning[];
		request: { body: unknown };
	}> {
		const { stream, request } = await this.doStream(options);
		const content: LanguageModelV4Content[] = [];
		const textBuf = new Map<string, string>();
		const reasoningBuf = new Map<string, string>();
		let finishReason: LanguageModelV4FinishReason = { unified: "other", raw: undefined };
		let usage: LanguageModelV4Usage = {
			inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: undefined, text: undefined, reasoning: undefined },
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
					// Cancel before rethrowing — the reader loop never
					// returns to the stream, so the body would leak.
					await reader.cancel();
					throw value.error;
			}
		}
		// Reasoning precedes text in the emitted content — matches how the
		// SDK lays out multi-part assistant output.
		return {
			content: [
				...[...reasoningBuf.values()].map(
					(text): LanguageModelV4Content => ({ type: "reasoning", text }),
				),
				...[...textBuf.values()].map(
					(text): LanguageModelV4Content => ({ type: "text", text }),
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
		authFile ? expandHome(authFile) : defaultCodexAuthFile(),
		fetchImpl,
	);
}

// "~/…" means the operator's home — the mini app's own placeholder uses it.
function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function defaultCodexAuthFile(): string {
	return join(homedir(), ".codex", "auth.json");
}
