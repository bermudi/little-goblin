// ai-sdk-provider-codex-cli is unusable here — it wraps the CLI's own
// agent loop (no caller tools) and can't drive goblin's turn loop.

import { createHash } from "node:crypto";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4Content,
	LanguageModelV4FinishReason,
	LanguageModelV4FunctionTool,
	LanguageModelV4Prompt,
	LanguageModelV4Reasoning,
	LanguageModelV4StreamPart,
	LanguageModelV4Text,
	LanguageModelV4Usage,
	SharedV4FileData,
	SharedV4ProviderMetadata,
	SharedV4Warning,
} from "@ai-sdk/provider";
import { z } from "zod";
import {
	codexCredentials,
	resolveCodexAuthFile,
	type CodexAuthFile,
	type FetchLike,
} from "./auth.ts";

export const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

// ---------- codex part metadata ----------
//
// Reasoning continuation needs the response items' opaque state back on the
// next request (store:false — nothing persists server-side). The adapter
// carries it under providerMetadata/providerOptions namespace `codex`:
// itemId + replayScope on every replayable item, reasoningEncryptedContent
// on reasoning, phase on assistant message items. replayScope binds the
// state to the resolved model+account so a model switch or re-login drops
// opaque state instead of replaying foreign ciphertext. The schema is the
// only reader — foreign or legacy reasoning has no `codex` namespace and is
// never echoed back.

const codexPartMetaSchema = z.object({
	// Optional on purpose: a wire item with no `id` still replays — only
	// real wire ids are ever stamped, never a synthesized placeholder.
	itemId: z.string().optional(),
	replayScope: z.string(),
	reasoningEncryptedContent: z.string().optional(),
	phase: z.enum(["commentary", "final_answer"]).optional(),
});

type CodexPartMeta = z.infer<typeof codexPartMetaSchema>;

// Validated `codex` namespace of a part's providerOptions — undefined when
// absent, null when present but malformed (a skip with a warning either
// way, but the caller names which).
function codexMetaOf(
	providerOptions: Record<string, unknown> | undefined,
): CodexPartMeta | null | undefined {
	const raw = providerOptions?.codex;
	if (raw === undefined) return undefined;
	const parsed = codexPartMetaSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

// Scope = the opaque state's ownership proof: model id + account id (or the
// auth file identity when the account id is absent). Computed from resolved
// auth, never from token material — same model+account survives a restart
// or a token refresh, everything else rejects the replay.
function replayScopeOf(modelId: string, auth: CodexAuthFile, authFile: string): string {
	return createHash("sha256")
		.update(JSON.stringify([modelId, auth.tokens.account_id ?? authFile]))
		.digest("hex");
}

// Stream-time metadata under the codex namespace — wire values are
// untyped, so phase/cipher ride only when they are the shape the schema
// owns; anything else is dropped rather than guessed at.
function streamMeta(
	scope: string,
	itemId: string | undefined,
	fields?: { encrypted?: unknown; phase?: unknown },
): SharedV4ProviderMetadata {
	const meta: CodexPartMeta = { replayScope: scope };
	if (itemId !== undefined) meta.itemId = itemId;
	if (typeof fields?.encrypted === "string") meta.reasoningEncryptedContent = fields.encrypted;
	if (fields?.phase === "commentary" || fields?.phase === "final_answer") {
		meta.phase = fields.phase;
	}
	return { codex: meta };
}

// ---------- prompt → responses input ----------

type ResponsesInputItem = Record<string, unknown>;

function fileToDataUrl(data: SharedV4FileData, mediaType: string): string {
	// Spec v4 tags the payload type — no guessing URL vs base64 vs data URL.
	if (data.type === "url") {
		return data.originalUrl ?? data.url.toString();
	}
	if (data.type === "reference") {
		throw new Error("codex: provider file references are not supported");
	}
	// "image" alone is a wildcard, not a data-URL media type — pin a
	// concrete subtype.
	const mime = mediaType === "image" ? "image/png" : mediaType;
	if (data.type === "text") {
		return `data:${mime};base64,${Buffer.from(data.text, "utf8").toString("base64")}`;
	}
	// A data: string rides through untouched rather than double-encoding.
	if (typeof data.data === "string") {
		return data.data.startsWith("data:") ? data.data : `data:${mime};base64,${data.data}`;
	}
	return `data:${mime};base64,${Buffer.from(data.data).toString("base64")}`;
}

// The Responses wire wants `arguments` as JSON text, but the SDK's model
// messages carry a tool call's input as its parsed value — stringify it
// or the backend rejects the request with invalid_type on input[n].
function argumentsText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "{}";
	return JSON.stringify(value) ?? "{}";
}

function toolResultText(output: { type: string; value?: unknown; reason?: unknown }): string {
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

// Reasoning parts ride back only with their opaque state — the backend
// accepts no reasoning echo without the encrypted item. A part whose codex
// metadata is absent, malformed, scoped to a different model/account, or
// cipherless is omitted with a metadata-only warning: the opaque state is
// never logged, and no payload is ever guessed from the visible summary.
function convertPrompt(
	prompt: LanguageModelV4Prompt,
	scope: string,
	warnings: SharedV4Warning[],
): {
	instructions: string | undefined;
	input: ResponsesInputItem[];
} {
	const instructions: string[] = [];
	const input: ResponsesInputItem[] = [];
	const warn = (message: string): void => {
		warnings.push({ type: "other", message });
	};
	// Codex replay metadata is usable only under this request's own scope —
	// malformed namespaces and foreign scopes drop to a warning, and the
	// part then falls back to its plain wire form (or, for reasoning, to
	// nothing — a bare summary is not a replayable item).
	const usableMeta = (
		providerOptions: Record<string, unknown> | undefined,
		kind: "reasoning" | "text" | "tool-call",
	): CodexPartMeta | null => {
		const meta = codexMetaOf(providerOptions);
		if (meta === undefined) {
			if (kind === "reasoning") {
				warn("codex reasoning part omitted — no replay metadata (foreign or legacy reasoning)");
			}
			return null;
		}
		if (meta === null) {
			warn(`codex ${kind} replay metadata malformed — opaque state not replayed`);
			return null;
		}
		if (meta.replayScope !== scope) {
			warn(`codex ${kind} replay metadata has a different scope — opaque state not replayed`);
			return null;
		}
		return meta;
	};
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
					} else if (part.mediaType === "image" || part.mediaType.startsWith("image/")) {
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
				const flush = (): void => {
					if (content.length === 0) return;
					// Copy — clearing the shared array below would empty
					// the message item that was just attached.
					input.push({ type: "message", role: "assistant", content: [...content] });
					content.length = 0;
				};
				for (const part of msg.content) {
					if (part.type === "reasoning") {
						const meta = usableMeta(part.providerOptions, "reasoning");
						if (meta === null) continue;
						if (meta.reasoningEncryptedContent === undefined) {
							warn("codex reasoning part omitted — no encrypted content to replay");
							continue;
						}
						flush();
						// The reasoning item replays at its own position: summary
						// text is human evidence only, the cipher carries the
						// continuation — a part without a summary still replays.
						input.push({
							type: "reasoning",
							...(meta.itemId !== undefined ? { id: meta.itemId } : {}),
							encrypted_content: meta.reasoningEncryptedContent,
							summary: part.text === "" ? [] : [{ type: "summary_text", text: part.text }],
						});
					} else if (part.type === "text") {
						const meta = usableMeta(part.providerOptions, "text");
						if (meta === null) {
							content.push({ type: "output_text", text: part.text });
							continue;
						}
						flush();
						// A scoped message item replays under its own id (and
						// phase) — it must not merge into the open text buffer.
						input.push({
							type: "message",
							role: "assistant",
							...(meta.itemId !== undefined ? { id: meta.itemId } : {}),
							...(meta.phase !== undefined ? { phase: meta.phase } : {}),
							content: [{ type: "output_text", text: part.text }],
						});
					} else if (part.type === "tool-call") {
						const meta = usableMeta(part.providerOptions, "tool-call");
						flush();
						input.push({
							type: "function_call",
							call_id: part.toolCallId,
							name: part.toolName,
							arguments: argumentsText(part.input),
							...(meta?.itemId !== undefined ? { id: meta.itemId } : {}),
						});
					}
					// Spec v4 also allows tool-result parts on assistant
					// messages for provider-executed tools — codex never
					// requests any, so dropping is the honest mapping.
				}
				flush();
				break;
			}
			case "tool":
				for (const part of msg.content) {
					// Codex never requests approvals, so an approval-response
					// part can't legitimately arrive — skipping (not throwing)
					// keeps a midflight SDK change from killing the turn.
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

async function* sseEvents(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	// Dispatch one SSE frame: yields its parsed data payload, returns
	// true when the frame was [DONE] — the stream stops there. A frame
	// may carry several data: lines (join per the SSE spec); event:/id:/
	// comment lines drop.
	const frameEvents = function* (
		frame: string,
		eof = false,
	): Generator<Record<string, unknown>, boolean> {
		const data = frame
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).trimStart())
			.join("\n");
		if (!data) return false;
		if (data === "[DONE]") return true;
		try {
			yield JSON.parse(data) as Record<string, unknown>;
		} catch (err) {
			// Mid-stream a malformed frame is a protocol break — die on it.
			// At EOF it is a connection cut mid-frame; the loop-end guard's
			// "ended before a terminal response" is the honest diagnosis,
			// so let it fire instead of masking it with a parse error.
			if (!eof) {
				throw new Error("codex stream contained a malformed SSE data frame", { cause: err });
			}
		}
		return false;
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		// A proxy folding line endings would wedge the frame scan (every
		// event sits buffered until the body ends). Whole-buffer replace
		// so a \r\n split across chunks still folds.
		buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
		let idx: number;
		while ((idx = buf.indexOf("\n\n")) !== -1) {
			const frame = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			if (yield* frameEvents(frame)) return;
		}
	}
	// EOF flush (the sibling zai adapter flushes the same case): a final
	// frame without its terminating blank line still dispatches — a
	// complete answer must not die as "ended before a terminal response"
	// because a proxy trimmed the last separator or the backend closed.
	buf += decoder.decode();
	if (buf.length > 0 && (yield* frameEvents(buf, true))) return;
}

// The stream part id correlates SDK blocks and may fall back freely;
// itemId is the wire id only — stamped into metadata solely when the
// wire actually carried one.
interface OpenItem {
	id: string;
	itemId: string | undefined;
	phase?: unknown;
}

interface StreamState {
	textOpen: OpenItem | null;
	reasoningOpen: OpenItem | null;
	reasoningDeltaSeen: boolean;
	sawToolCall: boolean;
	sawTerminal: boolean;
	// The request's replay scope — stamped into every item's codex
	// metadata so the next call can prove compatibility before replay.
	scope: string;
}

function mapEvent(
	event: Record<string, unknown>,
	state: StreamState,
	push: (p: LanguageModelV4StreamPart) => void,
): void {
	const type = event.type as string;
	const item = event.item as Record<string, unknown> | undefined;
	const wireId = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
	switch (type) {
		case "response.output_item.added":
			if (item?.type === "message") {
				state.textOpen = {
					id: String(item.id ?? "text"),
					itemId: wireId(item.id),
					phase: item.phase,
				};
				push({
					type: "text-start",
					id: state.textOpen.id,
					providerMetadata: streamMeta(state.scope, state.textOpen.itemId, {
						phase: item.phase,
					}),
				});
			} else if (item?.type === "reasoning") {
				state.reasoningOpen = {
					id: String(item.id ?? "reasoning"),
					itemId: wireId(item.id),
				};
				state.reasoningDeltaSeen = false;
				push({
					type: "reasoning-start",
					id: state.reasoningOpen.id,
					providerMetadata: streamMeta(state.scope, state.reasoningOpen.itemId, {
						encrypted: item.encrypted_content,
					}),
				});
			}
			break;
		case "response.output_text.delta":
			if (state.textOpen) {
				push({ type: "text-delta", id: state.textOpen.id, delta: String(event.delta ?? "") });
			}
			break;
		case "response.reasoning_summary_text.delta":
		case "response.reasoning_text.delta":
			if (state.reasoningOpen) {
				state.reasoningDeltaSeen = true;
				push({
					type: "reasoning-delta",
					id: state.reasoningOpen.id,
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
					input: argumentsText(item.arguments ?? "{}"),
					providerMetadata: streamMeta(state.scope, wireId(item.id)),
				});
			} else if (item?.type === "message") {
				const phase = item.phase ?? state.textOpen?.phase;
				if (state.textOpen) {
					push({
						type: "text-end",
						id: state.textOpen.id,
						providerMetadata: streamMeta(
							state.scope,
							wireId(item.id) ?? state.textOpen.itemId,
							{ phase },
						),
					});
					state.textOpen = null;
				} else {
					// A completed item with no added/delta stream — emit its
					// content rather than dropping the answer.
					const text = itemText(item, "content", "output_text");
					if (text) {
						const id = String(item.id ?? "text");
						const meta = streamMeta(state.scope, wireId(item.id), { phase });
						push({ type: "text-start", id, providerMetadata: meta });
						push({ type: "text-delta", id, delta: text });
						push({ type: "text-end", id, providerMetadata: meta });
					}
				}
			} else if (item?.type === "reasoning") {
				if (state.reasoningOpen) {
					// A summary that arrived only on the done item still
					// lands — the part ends carrying what the wire carried.
					if (!state.reasoningDeltaSeen) {
						const text = itemText(item, "summary", "summary_text");
						if (text) {
							push({
								type: "reasoning-delta",
								id: state.reasoningOpen.id,
								delta: text,
							});
						}
					}
					push({
						type: "reasoning-end",
						id: state.reasoningOpen.id,
						providerMetadata: streamMeta(
							state.scope,
							wireId(item.id) ?? state.reasoningOpen.itemId,
							{ encrypted: item.encrypted_content },
						),
					});
					state.reasoningOpen = null;
				} else {
					// A reasoning item seen only at completion still emits a
					// part — even an empty summary carries the encrypted state
					// the next request replays.
					const id = String(item.id ?? "reasoning");
					const text = itemText(item, "summary", "summary_text");
					const meta = streamMeta(state.scope, wireId(item.id), {
						encrypted: item.encrypted_content,
					});
					push({ type: "reasoning-start", id, providerMetadata: meta });
					if (text) push({ type: "reasoning-delta", id, delta: text });
					push({ type: "reasoning-end", id, providerMetadata: meta });
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
				push({
					type: "text-end",
					id: state.textOpen.id,
					providerMetadata: streamMeta(state.scope, state.textOpen.itemId, {
						phase: state.textOpen.phase,
					}),
				});
				state.textOpen = null;
			}
			if (state.reasoningOpen) {
				// No done item arrived — id and scope still stamp the part;
				// the cipher only exists on a completed item.
				push({
					type: "reasoning-end",
					id: state.reasoningOpen.id,
					providerMetadata: streamMeta(state.scope, state.reasoningOpen.itemId),
				});
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
			// Mark terminal or the loop-end guard pushes a second error
			// ("ended before a terminal response") that masks the real failure.
			state.sawTerminal = true;
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

// message.content[] output_text or reasoning.summary[] summary_text —
// wire-shaped, so fish out what's there.
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
				typeof p === "object" && p !== null && (p as { type?: unknown }).type === partType,
		)
		.map((p) => String(p.text ?? ""))
		.join("");
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function finishReasonOf(state: StreamState, status: unknown): LanguageModelV4FinishReason {
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
		warnings: SharedV4Warning[];
		scope: string;
	}> {
		const auth = await codexCredentials(this.authFile, this.fetchImpl);
		const scope = replayScopeOf(this.modelId, auth, this.authFile);
		const warnings: SharedV4Warning[] = [];
		const { instructions, input } = convertPrompt(options.prompt, scope, warnings);
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
			warnings,
			scope,
			headers: {
				authorization: `Bearer ${auth.tokens.access_token}`,
				"content-type": "application/json",
				...(auth.tokens.account_id ? { "chatgpt-account-id": auth.tokens.account_id } : {}),
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

	private async post(
		body: Record<string, unknown>,
		headers: Record<string, string>,
		signal?: AbortSignal,
	) {
		const res = await this.fetchImpl(RESPONSES_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: signal ?? null,
		});
		if (!res.ok || !res.body) {
			let detail: string;
			try {
				detail = await res.text();
			} catch (err) {
				throw new Error(`codex responses HTTP ${res.status}: error body read failed`, {
					cause: err,
				});
			}
			throw new Error(`codex responses HTTP ${res.status}: ${detail.slice(0, 500)}`);
		}
		return res;
	}

	async doStream(options: LanguageModelV4CallOptions): Promise<{
		stream: ReadableStream<LanguageModelV4StreamPart>;
		request: { body: unknown };
	}> {
		const { body, headers, warnings: conversionWarnings, scope } = await this.buildRequest(
			options,
		);
		const res = await this.post(body, headers, options.abortSignal);
		const warnings = [...this.warningsFor(options), ...conversionWarnings];
		const state: StreamState = {
			textOpen: null,
			reasoningOpen: null,
			reasoningDeltaSeen: false,
			sawToolCall: false,
			sawTerminal: false,
			scope,
		};
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
		// Content stays in streaming order — each opened block's slot is
		// fixed at its start part, so interleaved reasoning/text and the
		// calls between them keep the wire's sequence; start/end
		// providerMetadata lands verbatim (the codex replay state rides
		// it, including on empty reasoning blocks).
		const content: LanguageModelV4Content[] = [];
		const open = new Map<string, LanguageModelV4Text | LanguageModelV4Reasoning>();
		let finishReason: LanguageModelV4FinishReason = { unified: "other", raw: undefined };
		let warnings: SharedV4Warning[] = this.warningsFor(options);
		let usage: LanguageModelV4Usage = {
			inputTokens: {
				total: undefined,
				noCache: undefined,
				cacheRead: undefined,
				cacheWrite: undefined,
			},
			outputTokens: { total: undefined, text: undefined, reasoning: undefined },
		};
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			switch (value.type) {
				case "stream-start":
					// The stream's own warning set (option warnings plus any
					// prompt-conversion drops) is authoritative.
					warnings = value.warnings;
					break;
				case "text-start": {
					const block: LanguageModelV4Text = {
						type: "text",
						text: "",
						...(value.providerMetadata !== undefined
							? { providerMetadata: value.providerMetadata }
							: {}),
					};
					content.push(block);
					open.set(value.id, block);
					break;
				}
				case "text-delta": {
					let block = open.get(value.id);
					if (block?.type !== "text") {
						block = { type: "text" as const, text: "" };
						content.push(block);
						open.set(value.id, block);
					}
					block.text += value.delta;
					break;
				}
				case "text-end": {
					const block = open.get(value.id);
					if (block?.type === "text") {
						if (value.providerMetadata !== undefined) {
							block.providerMetadata = value.providerMetadata;
						}
						open.delete(value.id);
					}
					break;
				}
				case "reasoning-start": {
					const block: LanguageModelV4Reasoning = {
						type: "reasoning",
						text: "",
						...(value.providerMetadata !== undefined
							? { providerMetadata: value.providerMetadata }
							: {}),
					};
					content.push(block);
					open.set(value.id, block);
					break;
				}
				case "reasoning-delta": {
					let block = open.get(value.id);
					if (block?.type !== "reasoning") {
						block = { type: "reasoning" as const, text: "" };
						content.push(block);
						open.set(value.id, block);
					}
					block.text += value.delta;
					break;
				}
				case "reasoning-end": {
					const block = open.get(value.id);
					if (block?.type === "reasoning") {
						if (value.providerMetadata !== undefined) {
							block.providerMetadata = value.providerMetadata;
						}
						open.delete(value.id);
					}
					break;
				}
				case "tool-call":
					content.push({
						type: "tool-call",
						toolCallId: value.toolCallId,
						toolName: value.toolName,
						input: value.input,
						...(value.providerMetadata !== undefined
							? { providerMetadata: value.providerMetadata }
							: {}),
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
		return {
			// An opened text block that never received a delta emits nothing —
			// reasoning blocks stay either way (their replay state is the
			// metadata, not the text).
			content: content.filter((c) => c.type !== "text" || c.text !== ""),
			finishReason,
			usage,
			warnings,
			request,
		};
	}
}

export function codexModel(
	modelId: string,
	authFile?: string,
	fetchImpl: FetchLike = fetch,
): CodexLanguageModel {
	return new CodexLanguageModel(modelId, resolveCodexAuthFile(authFile).path, fetchImpl);
}
