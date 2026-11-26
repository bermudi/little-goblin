// Codex = the stock `@ai-sdk/openai` Responses model pointed at the
// ChatGPT backend, plus a thin codex edge: a fetch wrapper (auth and
// session headers, turn-state echo) and one middleware (instructions,
// call defaults, replay-scope gate, `openai` ↔ `codex` metadata
// namespace). ai-sdk-provider-codex-cli is unusable here — it wraps the
// CLI's own agent loop (no caller tools) and can't drive goblin's turn
// loop.

import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import type {
	JSONObject,
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4Content,
	LanguageModelV4FinishReason,
	LanguageModelV4GenerateResult,
	LanguageModelV4Message,
	LanguageModelV4Prompt,
	LanguageModelV4Reasoning,
	LanguageModelV4ResponseMetadata,
	LanguageModelV4StreamPart,
	LanguageModelV4StreamResult,
	LanguageModelV4Text,
	LanguageModelV4Usage,
	SharedV4ProviderMetadata,
	SharedV4ProviderOptions,
	SharedV4Warning,
} from "@ai-sdk/provider";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { ownedReader } from "../../dispose.ts";
import {
	codexCredentials,
	resolveCodexAuthFile,
	type CodexAuthFile,
	type FetchLike,
} from "./auth.ts";
import type { AppQuotaWindow } from "../../http/app-wire.ts";
import { quotaFromHeaders, type CodexQuota } from "./receipts.ts";
import {
	ADDITIONAL_TOOLS_PREFIX,
	toolDeclarationsSchema,
} from "../tool-declarations.ts";

const BASE_URL = "https://chatgpt.com/backend-api/codex";
export const RESPONSES_URL = `${BASE_URL}/responses`;

// Instance-scoped request identity: sessionId derives from the
// conversation (codexSessionId) and feeds the backend's cache-affinity
// headers plus prompt_cache_key; subagent marks maintenance calls.
export interface CodexModelOptions {
	sessionId?: string;
	subagent?: "compact";
}

// ---------- codex part metadata ----------
//
// Reasoning continuation needs the response items' opaque state back on
// the next request (store:false — nothing persists server-side). The
// stock model reads and writes it under the `openai` namespace; goblin
// stores it under `codex` with a replayScope that binds it to the
// resolved model+account, so a model switch or re-login drops opaque
// state instead of replaying foreign ciphertext. Output renames
// openai → codex (+scope); input moves in-scope codex → openai and
// drops everything else — including any `openai` state a different
// provider left on the part.

const codexPartMetaSchema = z.looseObject({
	itemId: z.string().optional(),
	replayScope: z.string(),
	reasoningEncryptedContent: z.string().nullish(),
	phase: z.enum(["commentary", "final_answer"]).optional(),
});

const callOptionsSchema = z.looseObject({ reasoningEffort: z.string().optional() });

// Scope = the opaque state's ownership proof: model id + account id (or the
// auth file identity when the account id is absent). Computed from resolved
// auth, never from token material — same model+account survives a restart
// or a token refresh, everything else rejects the replay.
function replayScopeOf(modelId: string, auth: CodexAuthFile, authFile: string): string {
	return createHash("sha256")
		.update(JSON.stringify([modelId, auth.tokens.account_id ?? authFile]))
		.digest("hex");
}

// One model instance is one turn attempt (callers resolve fresh per
// turn), so instance scope IS turn scope for the backend's affinity
// token: captured from the first non-empty response header, echoed on
// every later request, never shared across instances.
interface CodexTurn {
	turnState: string | null;
}

// ---------- fetch edge ----------

function codexFetch(
	authFile: string,
	fetchImpl: FetchLike,
	opts: CodexModelOptions,
	turn: CodexTurn,
): typeof fetch {
	const wrapped = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	): Promise<Response> => {
		const auth = await codexCredentials(authFile, fetchImpl);
		const headers = new Headers(init?.headers);
		// Replaces the SDK's placeholder bearer — the real token comes
		// from the auth file per request so CLI refreshes propagate.
		headers.set("authorization", `Bearer ${auth.tokens.access_token}`);
		if (auth.tokens.account_id) headers.set("chatgpt-account-id", auth.tokens.account_id);
		headers.set("OpenAI-Beta", "responses=experimental");
		headers.set("originator", "codex_cli_rs");
		headers.set("accept", "text/event-stream");
		if (opts.sessionId !== undefined) {
			headers.set("session-id", opts.sessionId);
			headers.set("thread-id", opts.sessionId);
		}
		if (opts.subagent !== undefined) headers.set("x-openai-subagent", opts.subagent);
		if (turn.turnState !== null) headers.set("x-codex-turn-state", turn.turnState);
		let requestInit = init;
		if (typeof init?.body === "string") {
			const body: unknown = JSON.parse(init.body);
			if (typeof body === "object" && body !== null && !Array.isArray(body)) {
				const record = body as Record<string, unknown>;
				if (Array.isArray(record.input)) {
					let replaced = 0;
					const mapped = record.input.map((item, index) => {
						if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
						const message = item as Record<string, unknown>;
						if (message.role !== "system" && message.role !== "developer") return item;
						const text =
							typeof message.content === "string"
								? message.content
								: Array.isArray(message.content)
									? message.content
											.map((part) =>
												typeof part === "object" &&
												part !== null &&
												"text" in part &&
												typeof part.text === "string"
													? part.text
													: "",
											)
											.join("")
									: "";
						if (!text.startsWith(ADDITIONAL_TOOLS_PREFIX)) return item;
						const raw = text.slice(ADDITIONAL_TOOLS_PREFIX.length);
						let declarations: unknown;
						try {
							declarations = toolDeclarationsSchema.parse(JSON.parse(raw) as unknown);
						} catch (error) {
							throw new Error(
								`invalid additional-tools marker at Codex input item ${index}`,
								{ cause: error },
							);
						}
						replaced += 1;
						return { type: "additional_tools", role: "developer", tools: declarations };
					});
					if (replaced > 0) {
						log.debug("codex additional tool items rewritten", { count: replaced });
						requestInit = {
							...init,
							body: JSON.stringify({ ...record, input: mapped }),
						};
					}
				}
			}
		}
		const res = await fetchImpl(input, { ...requestInit, headers });
		if (turn.turnState === null) {
			const ts = res.headers.get("x-codex-turn-state");
			if (ts !== null && ts.length > 0) turn.turnState = ts;
		}
		if (!res.ok) {
			// A usage-limit 429 must explain itself in the logs — the body
			// rides the SDK's APICallError; the line carries the receipts.
			const quota = quotaFromHeaders(res.headers);
			log.warn("codex responses http error", {
				status: res.status,
				sessionId: opts.sessionId ?? null,
				requestId: res.headers.get("x-request-id"),
				primaryUsedPercent: quota?.primary?.usedPercent ?? null,
				primaryResetsAt: quota?.primary?.resetsAt ?? null,
				secondaryUsedPercent: quota?.secondary?.usedPercent ?? null,
				secondaryResetsAt: quota?.secondary?.resetsAt ?? null,
			});
		}
		return res;
	};
	return Object.assign(wrapped, { preconnect: fetch.preconnect });
}

// ---------- params: prompt + call defaults ----------

type NonSystem = Exclude<LanguageModelV4Message, { role: "system" }>;
type Part = NonSystem["content"][number];

interface Drops {
	reasons: Set<string>;
	parts: number;
}

// Moves a part's in-scope codex state to `openai`; anything else in
// either namespace is dropped. Returns the in-scope meta (or null).
function scopedOptions(
	providerOptions: SharedV4ProviderOptions | undefined,
	scope: string,
	drops: Drops,
): { options: SharedV4ProviderOptions | undefined; meta: z.infer<typeof codexPartMetaSchema> | null } {
	if (providerOptions === undefined) return { options: undefined, meta: null };
	const { codex, openai, ...rest } = providerOptions;
	if (openai !== undefined) {
		drops.reasons.add("foreign openai state");
		drops.parts++;
	}
	if (codex === undefined) return { options: rest, meta: null };
	const parsed = codexPartMetaSchema.safeParse(codex);
	if (!parsed.success) {
		drops.reasons.add("malformed");
		drops.parts++;
		return { options: rest, meta: null };
	}
	if (parsed.data.replayScope !== scope) {
		drops.reasons.add("out of scope");
		drops.parts++;
		return { options: rest, meta: null };
	}
	const { replayScope: _scope, ...state } = parsed.data;
	return { options: { ...rest, openai: state as JSONObject }, meta: parsed.data };
}

function hasCipher(meta: { reasoningEncryptedContent?: string | null | undefined } | null): boolean {
	return typeof meta?.reasoningEncryptedContent === "string";
}

function scopedPrompt(prompt: LanguageModelV4Prompt, scope: string, drops: Drops): LanguageModelV4Prompt {
	const out: LanguageModelV4Prompt = [];
	for (const msg of prompt) {
		if (msg.role === "system") {
			const codexOptions = msg.providerOptions?.codex;
			if (typeof codexOptions !== "object" || codexOptions === null || !("inInput" in codexOptions) || codexOptions.inInput !== true) {
				continue;
			}
			const { inInput: _inInput, ...restCodex } = codexOptions;
			const { codex: _codex, ...rest } = msg.providerOptions ?? {};
			const providerOptions = Object.keys(restCodex).length > 0
				? { ...rest, codex: restCodex }
				: rest;
			const { providerOptions: _providerOptions, ...bare } = msg;
			out.push(
				Object.keys(providerOptions).length > 0
					? { ...bare, providerOptions }
					: bare,
			);
			continue;
		}
		const parts: readonly Part[] = msg.content;
		const mapped = parts.map((part) => {
			const { options, meta } = scopedOptions(part.providerOptions, scope, drops);
			return { part, options, meta };
		});
		// The stock converter merges reasoning parts by itemId, so a
		// cipherless part (a summary concluded before its item finished)
		// replays when a sibling of the same item carries the cipher.
		const cipherItems = new Set(
			mapped
				.filter((m) => m.part.type === "reasoning" && hasCipher(m.meta) && m.meta?.itemId !== undefined)
				.map((m) => m.meta!.itemId),
		);
		const content: Part[] = [];
		for (const { part, options, meta } of mapped) {
			if (
				part.type === "reasoning" &&
				!hasCipher(meta) &&
				!(meta?.itemId !== undefined && cipherItems.has(meta.itemId))
			) {
				drops.reasons.add("reasoning without in-scope cipher");
				drops.parts++;
				continue;
			}
			const { providerOptions: _old, ...bare } = part;
			content.push((options === undefined ? bare : { ...bare, providerOptions: options }) as Part);
		}
		if (content.length === 0 && msg.role === "assistant") continue;
		out.push({ ...msg, content } as NonSystem);
	}
	return out;
}

async function codexParams(
	params: LanguageModelV4CallOptions,
	scope: string,
	opts: CodexModelOptions,
): Promise<LanguageModelV4CallOptions> {
	const drops: Drops = { reasons: new Set(), parts: 0 };
	// The backend takes the system prompt as `instructions`, never as an
	// input item — and wants the field even when empty.
	const isInInputSystem = (message: LanguageModelV4Message): boolean => {
		if (message.role !== "system") return false;
		const codex = message.providerOptions?.codex;
		return typeof codex === "object" && codex !== null && "inInput" in codex && codex.inInput === true;
	};
	const instructions = params.prompt
		.filter((m) => m.role === "system" && !isInInputSystem(m))
		.map((m) => m.content)
		.join("\n\n");
	const prompt = scopedPrompt(params.prompt, scope, drops);
	if (drops.parts > 0) {
		log.warn("codex replay state dropped", {
			reason: [...drops.reasons].join(", "),
			parts: drops.parts,
		});
	}
	const callOpts = callOptionsSchema.parse(params.providerOptions?.codex ?? {});
	const prior = params.providerOptions?.openai ?? {};
	const priorInclude = Array.isArray(prior.include)
		? prior.include.filter((v): v is string => typeof v === "string")
		: [];
	const openai: JSONObject = {
		...prior,
		store: false,
		include: [...new Set([...priorInclude, "reasoning.encrypted_content"])],
		instructions,
		...(opts.sessionId !== undefined ? { promptCacheKey: opts.sessionId } : {}),
		...(callOpts.reasoningEffort !== undefined
			? { reasoningEffort: callOpts.reasoningEffort, reasoningSummary: "auto" }
			: {}),
	};
	return { ...params, prompt, providerOptions: { ...params.providerOptions, openai } };
}

// ---------- stream: namespace rename, receipts, hosted search ----------

function renamedMeta(meta: SharedV4ProviderMetadata, scope: string): SharedV4ProviderMetadata {
	const { openai, ...rest } = meta;
	if (openai === undefined) return meta;
	const codex: JSONObject = { ...rest.codex, ...openai };
	// The stock model stamps `null` before the cipher exists; the stored
	// shape carries a string or nothing.
	if (codex.reasoningEncryptedContent === null) delete codex.reasoningEncryptedContent;
	if (typeof codex.itemId === "string") codex.replayScope = scope;
	return { ...rest, codex };
}

function webSearchLog(result: unknown, isError: boolean | undefined): Record<string, unknown> {
	const r = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
	const action =
		typeof r.action === "object" && r.action !== null ? (r.action as Record<string, unknown>) : {};
	return {
		status: isError === true ? String(r.status ?? "failed") : "completed",
		actionType: String(action.type ?? "unknown"),
		query: String(action.query ?? "").slice(0, 200),
		sourceCount: Array.isArray(r.sources) ? r.sources.length : 0,
	};
}

function windowJson(w: AppQuotaWindow | null): JSONObject | null {
	return w === null ? null : { usedPercent: w.usedPercent, windowMinutes: w.windowMinutes, resetsAt: w.resetsAt };
}

function quotaJson(q: CodexQuota): JSONObject {
	return { limitName: q.limitName, primary: windowJson(q.primary), secondary: windowJson(q.secondary) };
}

// Shared by wrapStream and wrapGenerate: every part's `openai` metadata
// becomes `codex` (+replayScope where an item id is present), the finish
// part gains the header quota, and the receipts / hosted-search lines
// land in the log.
function codexStream(
	result: LanguageModelV4StreamResult,
	scope: string,
	opts: CodexModelOptions,
	turn: CodexTurn,
): LanguageModelV4StreamResult {
	const headers = new Headers(result.response?.headers);
	const quota = quotaFromHeaders(headers);
	// One receipts line per response — booleans/percentages only, the
	// turn-state value and credentials never appear.
	log.info("codex response receipts", {
		sessionId: opts.sessionId ?? null,
		subagent: opts.subagent ?? null,
		requestId: headers.get("x-request-id"),
		servedModel: headers.get("openai-model"),
		turnStateHeld: turn.turnState !== null,
		primaryUsedPercent: quota?.primary?.usedPercent ?? null,
		primaryWindowMinutes: quota?.primary?.windowMinutes ?? null,
		primaryResetsAt: quota?.primary?.resetsAt ?? null,
		secondaryUsedPercent: quota?.secondary?.usedPercent ?? null,
		secondaryWindowMinutes: quota?.secondary?.windowMinutes ?? null,
		secondaryResetsAt: quota?.secondary?.resetsAt ?? null,
	});
	const hostedCalls = new Set<string>();
	const transform = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
		transform(part, controller) {
			let next: LanguageModelV4StreamPart = part;
			if ("providerMetadata" in part && part.providerMetadata !== undefined) {
				next = { ...part, providerMetadata: renamedMeta(part.providerMetadata, scope) };
			}
			if (next.type === "tool-call" && next.providerExecuted === true) {
				hostedCalls.add(next.toolCallId);
			}
			if (next.type === "tool-result" && hostedCalls.has(next.toolCallId)) {
				// Provider-executed: never a goblin tool call — the line is
				// the only trace of what the backend searched.
				log.info("codex hosted search", {
					sessionId: opts.sessionId ?? null,
					...webSearchLog(next.result, next.isError),
				});
			}
			if (next.type === "finish" && quota !== null) {
				const meta = next.providerMetadata ?? {};
				next = { ...next, providerMetadata: { ...meta, codex: { ...meta.codex, quota: quotaJson(quota) } } };
			}
			controller.enqueue(next);
		},
	});
	return { ...result, stream: result.stream.pipeThrough(transform) };
}

// The backend rejects non-streaming requests (HTTP 400 "Stream must be
// set to true"), so generate collects the stream. Content stays in
// stream order — each block's slot is fixed at its start part — and
// start/end providerMetadata lands verbatim (the replay state rides it,
// including on empty reasoning blocks).
async function collectGenerate(result: LanguageModelV4StreamResult): Promise<LanguageModelV4GenerateResult> {
	const content: LanguageModelV4Content[] = [];
	const open = new Map<string, LanguageModelV4Text | LanguageModelV4Reasoning>();
	let finishReason: LanguageModelV4FinishReason = { unified: "other", raw: undefined };
	let finishMeta: SharedV4ProviderMetadata | undefined;
	let warnings: SharedV4Warning[] = [];
	let responseMeta: LanguageModelV4ResponseMetadata = {};
	let usage: LanguageModelV4Usage = {
		inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
		outputTokens: { total: undefined, text: undefined, reasoning: undefined },
	};
	const block = (
		type: "text" | "reasoning",
		id: string,
		meta: SharedV4ProviderMetadata | undefined,
	): LanguageModelV4Text | LanguageModelV4Reasoning => {
		const extra = meta !== undefined ? { providerMetadata: meta } : {};
		const b: LanguageModelV4Text | LanguageModelV4Reasoning =
			type === "text" ? { type, text: "", ...extra } : { type, text: "", ...extra };
		content.push(b);
		open.set(id, b);
		return b;
	};
	await using owner = ownedReader(result.stream);
	const { reader } = owner;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		switch (value.type) {
			case "stream-start":
				warnings = value.warnings;
				break;
			case "response-metadata": {
				const { type: _t, ...meta } = value;
				responseMeta = { ...responseMeta, ...meta };
				break;
			}
			case "text-start":
			case "reasoning-start":
				block(value.type === "text-start" ? "text" : "reasoning", value.id, value.providerMetadata);
				break;
			case "text-delta":
			case "reasoning-delta": {
				const kind = value.type === "text-delta" ? "text" : "reasoning";
				let b = open.get(value.id);
				if (b?.type !== kind) b = block(kind, value.id, undefined);
				b.text += value.delta;
				break;
			}
			case "text-end":
			case "reasoning-end": {
				const b = open.get(value.id);
				if (b !== undefined) {
					if (value.providerMetadata !== undefined) b.providerMetadata = value.providerMetadata;
					open.delete(value.id);
				}
				break;
			}
			case "tool-call":
			case "tool-result":
			case "tool-approval-request":
			case "source":
			case "file":
			case "reasoning-file":
			case "custom":
				content.push(value);
				break;
			case "finish":
				finishReason = value.finishReason;
				usage = value.usage;
				finishMeta = value.providerMetadata;
				break;
			case "error":
				// Throw exits the loop; the reader owner cancels on scope exit.
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
		...(result.request !== undefined ? { request: result.request } : {}),
		response: { ...responseMeta, ...(result.response?.headers !== undefined ? { headers: result.response.headers } : {}) },
		...(finishMeta !== undefined ? { providerMetadata: finishMeta } : {}),
	};
}

// ---------- the model ----------

function codexMiddleware(
	modelId: string,
	authFile: string,
	fetchImpl: FetchLike,
	opts: CodexModelOptions,
	turn: CodexTurn,
): LanguageModelMiddleware {
	// wrapLanguageModel hands the transformed params object to the
	// wrappers — keying the scope on it keeps concurrent calls apart.
	const scopes = new WeakMap<LanguageModelV4CallOptions, string>();
	const scopeOf = (params: LanguageModelV4CallOptions): string => {
		const scope = scopes.get(params);
		if (scope === undefined) throw new Error("codex: call params bypassed transformParams");
		return scope;
	};
	return {
		specificationVersion: "v4",
		transformParams: async ({ params }) => {
			const auth = await codexCredentials(authFile, fetchImpl);
			const scope = replayScopeOf(modelId, auth, authFile);
			const next = await codexParams(params, scope, opts);
			scopes.set(next, scope);
			return next;
		},
		wrapStream: async ({ doStream, params }) =>
			codexStream(await doStream(), scopeOf(params), opts, turn),
		wrapGenerate: async ({ doStream, params }) =>
			collectGenerate(codexStream(await doStream(), scopeOf(params), opts, turn)),
	};
}

export function codexModel(
	modelId: string,
	authFile?: string,
	fetchImpl: FetchLike = fetch,
	opts: CodexModelOptions = {},
): LanguageModelV4 {
	const path = resolveCodexAuthFile(authFile).path;
	const turn: CodexTurn = { turnState: null };
	const provider = createOpenAI({
		name: "codex",
		baseURL: BASE_URL,
		// Placeholder only — codexFetch replaces the bearer per request.
		apiKey: "unused",
		fetch: codexFetch(path, fetchImpl, opts, turn),
	});
	return wrapLanguageModel({
		model: provider.responses(modelId),
		middleware: codexMiddleware(modelId, path, fetchImpl, opts, turn),
	});
}
