// Hindsight boundary: HTTP only. No model selection or automatic bank creation.
// Wire contract: https://hindsight.vectorize.io/openapi.json (0.10).
import { z } from "zod";
import { createHash } from "node:crypto";
import { log } from "./log.ts";

const identifier = z.string().min(1).max(256).refine((value) => value !== "." && value !== "..");
const baseUrlSchema = z.url().superRefine((value, ctx) => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		ctx.addIssue({ code: "custom", message: "Invalid Hindsight URL" });
		return;
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
		url.username || url.password || url.search || url.hash
	) {
		ctx.addIssue({
			code: "custom",
			message: "Hindsight URL must use HTTPS (or loopback HTTP), without credentials, query, or fragment",
		});
	}
});

export const hindsightConnectionSchema = z.object({
	baseUrl: baseUrlSchema,
	bankId: identifier,
	timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
});

export const memoryDocumentSchema = z.object({
	id: identifier,
	content: z.string().min(1).max(64_000),
	timestamp: z.iso.datetime({ offset: true }),
	conversationId: identifier,
	sourceIds: z.array(identifier).min(1).max(100),
});
export type MemoryDocument = z.infer<typeof memoryDocumentSchema>;

const factSchema = z.object({
	id: identifier,
	text: z.string().max(64_000),
	type: z.string().max(128).nullish(),
	document_id: identifier.nullish(),
	context: z.string().max(16_000).nullish(),
	occurred_start: z.string().max(128).nullish(),
	occurred_end: z.string().max(128).nullish(),
	mentioned_at: z.string().max(128).nullish(),
	source_fact_ids: z.array(identifier).max(1_000).nullish(),
});
const recallSchema = z.object({
	results: z.array(factSchema).max(1_000),
});
export type RecalledFact = z.infer<typeof factSchema>;

const documentSchema = z.object({
	id: identifier,
	bank_id: identifier,
	original_text: z.string().max(512_000).nullable(),
	created_at: z.string().max(128),
	updated_at: z.string().max(128),
	memory_unit_count: z.number().int().nonnegative(),
});
export type StoredMemoryDocument = z.infer<typeof documentSchema>;

const retainSchema = z.object({
	success: z.literal(true),
	bank_id: identifier,
	items_count: z.literal(1),
	async: z.boolean(),
	operation_id: z.uuid().nullish(),
	operation_ids: z.array(z.uuid()).nullish(),
});
const operationSchema = z.object({
	operation_id: z.uuid(),
	status: z.enum(["pending", "processing", "completed", "failed", "cancelled", "not_found"]),
});
export type MemoryOperation = z.infer<typeof operationSchema>;

type FailureKind = "http" | "transport" | "timeout" | "cancelled" | "protocol" | "auth";
export class HindsightError extends Error {
	constructor(
		readonly kind: FailureKind,
		readonly status?: number,
	) {
		// No server bodies, auth-command output, fetch errors, or URLs in errors.
		super(`Hindsight ${kind} failure${status === undefined ? "" : ` (HTTP ${status})`}`);
		this.name = "HindsightError";
	}

	get retryable(): boolean {
		return this.kind === "transport" || this.kind === "timeout" ||
			(this.kind === "http" && (
				this.status === 408 || this.status === 429 || (this.status ?? 0) >= 500
			));
	}
}

const MAX_RESPONSE_BYTES = 1_048_576;

async function readJson(response: Response): Promise<unknown> {
	if (!response.body) throw new HindsightError("protocol");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new HindsightError("protocol");
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
	} catch {
		throw new HindsightError("protocol");
	}
}

export class HindsightClient {
	readonly target: string;
	private readonly base: string;
	private readonly bankId: string;
	private readonly timeoutMs: number;
	private readonly auth: (() => Promise<string>) | undefined;

	constructor(options: {
		baseUrl: string;
		bankId: string;
		timeoutMs?: number;
		auth?: () => Promise<string>;
	}) {
		const parsed = hindsightConnectionSchema.safeParse(options);
		// Validation errors must not echo credentials accidentally supplied in a URL.
		if (!parsed.success) throw new Error("Invalid Hindsight connection configuration");
		this.base = `${parsed.data.baseUrl.replace(/\/+$/, "")}/v1/default/banks/${encodeURIComponent(parsed.data.bankId)}`;
		this.target = createHash("sha256")
			.update(JSON.stringify([new URL(parsed.data.baseUrl).href.replace(/\/+$/, ""), parsed.data.bankId]))
			.digest("hex");
		this.bankId = parsed.data.bankId;
		this.timeoutMs = parsed.data.timeoutMs;
		this.auth = options.auth;
	}

	private async request<T>(
		operation: string,
		path: string,
		method: "GET" | "POST" | "DELETE",
		schema: z.ZodType<T>,
		options: { body?: unknown; signal?: AbortSignal | undefined; missing?: boolean; document?: string } = {},
	): Promise<T | null> {
		const started = Date.now();
		const controller = new AbortController();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.timeoutMs);
		const cancel = () => controller.abort();
		options.signal?.addEventListener("abort", cancel, { once: true });
		if (options.signal?.aborted) controller.abort();
		let abortListener: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			abortListener = () => reject(new HindsightError(timedOut ? "timeout" : "cancelled"));
			controller.signal.addEventListener("abort", abortListener, { once: true });
			if (controller.signal.aborted) abortListener();
		});
		const fields = { operation, bank: this.bankId, document: options.document };
		log.info("memory request", fields);
		try {
			const work = async (): Promise<T | null> => {
				controller.signal.throwIfAborted();
				let token: string | undefined;
				if (this.auth) {
					try {
						token = await this.auth();
						if (!token.trim() || /[\r\n]/.test(token)) throw new Error("invalid auth");
					} catch {
						throw new HindsightError("auth");
					}
				}
				controller.signal.throwIfAborted();
				const response = await fetch(`${this.base}${path}`, {
					method,
					redirect: "error", // Never forward a credential to a redirected service.
					signal: controller.signal,
					headers: {
						accept: "application/json",
						...(options.body === undefined ? {} : { "content-type": "application/json" }),
						...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
					},
					...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
				});
				if (!response.ok) {
					await response.body?.cancel();
					if (response.status === 404 && options.missing) return null;
					throw new HindsightError("http", response.status);
				}
				const parsed = schema.safeParse(await readJson(response));
				if (!parsed.success) throw new HindsightError("protocol");
				return parsed.data;
			};
			const result = await Promise.race([work(), aborted]);
			log.info("memory request completed", {
				...fields, durationMs: Date.now() - started, missing: result === null,
			});
			return result;
		} catch (err) {
			const failure = controller.signal.aborted
				? new HindsightError(timedOut ? "timeout" : "cancelled")
				: err instanceof HindsightError ? err : new HindsightError("transport");
			log.warn("memory request failed", {
				...fields, durationMs: Date.now() - started,
				kind: failure.kind, status: failure.status, retryable: failure.retryable,
			});
			throw failure;
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", cancel);
			if (abortListener) controller.signal.removeEventListener("abort", abortListener);
		}
	}

	async recall(query: string, options: {
		signal?: AbortSignal;
		maxTokens?: number;
		budget?: "low" | "mid" | "high";
	} = {}): Promise<RecalledFact[]> {
		const input = z.object({
			query: z.string().min(1).max(8_000),
			max_tokens: z.number().int().min(1).max(8_192),
			budget: z.enum(["low", "mid", "high"]),
		}).parse({ query, max_tokens: options.maxTokens ?? 2_048, budget: options.budget ?? "low" });
		const result = await this.request("recall", "/memories/recall", "POST", recallSchema, {
			body: input, signal: options.signal,
		});
		if (!result) throw new HindsightError("protocol");
		log.info("memory recalled", { bank: this.bankId, count: result.results.length });
		return result.results;
	}

	// Caller must persist this UUID before submission. A lost acknowledgement
	// can then be retried with the same operation identity without duplicate work.
	// Submission is NOT completion: poll operation() before marking a queue row done.
	async submit(document: MemoryDocument, operationId: string, signal?: AbortSignal): Promise<void> {
		const doc = memoryDocumentSchema.parse(document);
		const id = z.uuid().parse(operationId);
		const responseSchema = retainSchema.refine((r) =>
			r.bank_id === this.bankId && r.async && r.operation_id === id &&
			(!r.operation_ids || (r.operation_ids.length === 1 && r.operation_ids[0] === id)));
		await this.request("retain", "/memories", "POST", responseSchema, {
			signal, document: doc.id,
			body: {
				async: true,
				operation_id: id,
				items: [{
					document_id: doc.id,
					update_mode: "replace",
					content: doc.content,
					timestamp: doc.timestamp,
					context: "Telegram exchange. Operator and Goblin speakers are labelled. Assistant suggestions are not operator decisions.",
					metadata: {
						source: "goblin",
						conversation_id: doc.conversationId,
						source_ids: JSON.stringify(doc.sourceIds),
					},
				}],
			},
		});
	}

	async operation(operationId: string, signal?: AbortSignal): Promise<MemoryOperation | null> {
		const id = z.uuid().parse(operationId);
		const result = await this.request("operation", `/operations/${encodeURIComponent(id)}`, "GET",
			operationSchema.refine((r) => r.operation_id === id),
			{ signal, missing: true });
		return result?.status === "not_found" ? null : result;
	}

	async getDocument(documentId: string, signal?: AbortSignal): Promise<StoredMemoryDocument | null> {
		const id = identifier.parse(documentId);
		return this.request("document", `/documents/${encodeURIComponent(id)}`, "GET",
			documentSchema.refine((r) => r.id === id && r.bank_id === this.bankId),
			{ signal, missing: true, document: id });
	}

	// Caller owns operator confirmation, suppression, and settling any in-flight
	// retain operation first. HTTP success alone is not a complete forgetting policy.
	async deleteDocument(documentId: string, signal?: AbortSignal): Promise<void> {
		const id = identifier.parse(documentId);
		await this.request("delete", `/documents/${encodeURIComponent(id)}`, "DELETE",
			z.object({ success: z.literal(true), document_id: z.literal(id) }),
			{ signal, missing: true, document: id });
	}
}
