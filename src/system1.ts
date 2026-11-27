import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { System1Config } from "./config-schema.ts";
import { log } from "./log.ts";
import { ownedReader } from "./dispose.ts";
import { after } from "./timing.ts";

export const DEFAULT_MODEL = "typesafe/jev-1.13";
export const FALLBACK_MODEL = DEFAULT_MODEL;

type FailureKind = "http" | "transport" | "timeout" | "protocol" | "auth";

export class System1Error extends Error {
	constructor(
		readonly kind: FailureKind,
		readonly status?: number,
	) {
		// No server bodies, auth-command output, fetch errors, or URLs in errors.
		super(`System1 ${kind} failure${status === undefined ? "" : ` (HTTP ${status})`}`);
		this.name = "System1Error";
	}
}

export interface System1Question {
	type: "noul";
	instructions: string;
	criteria: { true: string; false: string };
}

const noulAnswerSchema = z.object({
	type: z.literal("noul"),
	noul: z.number().min(0).max(1),
});

const openRouterResponse = z.object({
	answers: z.record(z.string(), z.unknown()),
	usage: z
		.object({
			input_tokens: z.number().optional(),
			output_tokens: z.number().optional(),
			cost: z.number().optional(),
		})
		.optional(),
});

const openAIDecisionsResponse = z.object({
	answers: z.array(
		z.object({
			type: z.literal("predicate"),
			name: z.string(),
			probability: z.number().min(0).max(1),
		}),
	),
	usage: z.object({ input_tokens: z.number().int().nonnegative().nullish() }).nullish(),
});

export interface System1Decision {
	/** Asked question id → yes-probability. */
	answers: Record<string, number>;
	inputTokens: number | null;
	cost: number | null;
}

type System1Kind = NonNullable<System1Config["kind"]>;
type System1Route =
	| Omit<Extract<System1Config, { kind?: "openrouter" | undefined }>, "auth">
	| Omit<Extract<System1Config, { kind: "openai-decisions" }>, "auth">;

interface DecisionProtocol {
	path: string;
	encode(state: unknown, questions: Record<string, System1Question>): object;
	decode(json: unknown, questionIds: readonly string[]): System1Decision;
}

const protocols: Record<System1Kind, DecisionProtocol> = {
	openrouter: {
		path: "/api/alpha/decisions",
		encode: (state, questions) => ({ state, questions }),
		decode(json, questionIds) {
			const parsed = openRouterResponse.safeParse(json);
			if (!parsed.success) throw new System1Error("protocol");
			const answers = questionIds.map((id) => {
				const answer = noulAnswerSchema.safeParse(parsed.data.answers[id]);
				if (!answer.success) throw new System1Error("protocol");
				return [id, answer.data.noul] as const;
			});
			return {
				answers: Object.fromEntries(answers),
				inputTokens: parsed.data.usage?.input_tokens ?? null,
				cost: parsed.data.usage?.cost ?? null,
			};
		},
	},
	"openai-decisions": {
		path: "/decisions",
		encode(state, questions) {
			const input = typeof state === "string" ? state : JSON.stringify(state);
			if (input === undefined) throw new TypeError("System1 state must be JSON-serializable");
			return {
				input,
				questions: Object.entries(questions).map(([name, question]) => ({
					type: "predicate",
					name,
					instructions: `${question.instructions}\n\nCriteria for true:\n${question.criteria.true}\n\nCriteria for false:\n${question.criteria.false}`,
				})),
			};
		},
		decode(json, questionIds) {
			const parsed = openAIDecisionsResponse.safeParse(json);
			if (!parsed.success || parsed.data.answers.length !== questionIds.length)
				throw new System1Error("protocol");
			const answers = new Map(
				parsed.data.answers.map(({ name, probability }) => [name, probability]),
			);
			if (!questionIds.every((id) => answers.has(id))) throw new System1Error("protocol");
			return {
				answers: Object.fromEntries(answers),
				inputTokens: parsed.data.usage?.input_tokens ?? null,
				cost: null,
			};
		},
	},
};

const MAX_RESPONSE_BYTES = 1_048_576;

async function readJson(response: Response): Promise<unknown> {
	if (!response.body) throw new System1Error("protocol");
	await using owner = ownedReader(response.body);
	const { reader } = owner;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) throw new System1Error("protocol");
		chunks.push(value);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new System1Error("protocol");
	}
}

export class System1Client {
	private readonly kind: System1Kind;
	private readonly protocol: DecisionProtocol;
	private readonly url: string;
	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly auth: () => Promise<string>;
	private readonly fallback: boolean;

	constructor(
		options: System1Route & {
			timeoutMs?: number;
			fallback?: boolean;
			auth: () => Promise<string>;
		},
	) {
		this.kind = options.kind ?? "openrouter";
		this.protocol = protocols[this.kind];
		this.url = `${(options.baseUrl ?? "https://openrouter.ai").replace(/\/+$/, "")}${this.protocol.path}`;
		this.model = options.model ?? DEFAULT_MODEL;
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.auth = options.auth;
		this.fallback = this.kind === "openrouter" && (options.fallback ?? true);
	}

	async decide(
		state: unknown,
		questions: Record<string, System1Question>,
		options: { timeoutMs?: number } = {},
	): Promise<System1Decision> {
		// Serialize once before any await: a fallback must see exactly the
		// same input, even if the caller mutates it during the first call.
		// Serialization failures are programming errors, not transport failures.
		const input = JSON.stringify(this.protocol.encode(state, questions));
		const questionIds = Object.keys(questions);
		const requestId = randomUUID();
		const inputHash = createHash("sha256").update(input).digest("hex").slice(0, 16);
		const timeoutMs = Math.min(this.timeoutMs, options.timeoutMs ?? this.timeoutMs);
		const started = performance.now();
		const controller = new AbortController();
		const timeout = after(timeoutMs, "system1 request timeout", () => controller.abort());
		const remaining = (): number => Math.max(0, timeoutMs - (performance.now() - started));
		let model = this.model;
		try {
			const token = await this.authorize(controller.signal);
			const canFallback = this.fallback && this.model !== FALLBACK_MODEL;
			const attempt = (attemptModel: string, budgetMs: number): Promise<System1Decision> => {
				log.info("system1 request", {
					requestId,
					backend: this.kind,
					model: attemptModel,
					fallback: attemptModel !== this.model,
					questionIds,
					inputHash,
					timeoutMs: Math.floor(budgetMs),
				});
				// input is a serialized object. Insert only the model field;
				// all state/question bytes remain identical across attempts.
				const body = `{"model":${JSON.stringify(attemptModel)},${input.slice(1)}`;
				return this.attempt(body, questionIds, token, budgetMs, controller.signal);
			};
			let decision: System1Decision;
			try {
				decision = await attempt(model, remaining() / (canFallback ? 2 : 1));
			} catch (err) {
				if (
					!(err instanceof System1Error) ||
					!canFallback ||
					err.kind === "auth" ||
					err.status === 401 ||
					err.status === 403 ||
					controller.signal.aborted ||
					remaining() <= 0
				)
					throw err;
				log.warn("system1 fallback", {
					requestId,
					model,
					fallbackModel: FALLBACK_MODEL,
					kind: err.kind,
					status: err.status ?? null,
					ms: Math.round(performance.now() - started),
				});
				model = FALLBACK_MODEL;
				decision = await attempt(model, remaining());
			}
			log.info("system1 decision", {
				requestId,
				backend: this.kind,
				model,
				fallback: model !== this.model,
				answers: decision.answers,
				inputTokens: decision.inputTokens,
				cost: decision.cost,
				ms: Math.round(performance.now() - started),
			});
			return decision;
		} catch (err) {
			if (err instanceof System1Error) {
				log.warn("system1 failed", {
					requestId,
					backend: this.kind,
					model,
					fallback: model !== this.model,
					kind: err.kind,
					status: err.status ?? null,
					ms: Math.round(performance.now() - started),
				});
			}
			throw err;
		} finally {
			timeout.cancel();
			controller.abort();
		}
	}

	private async authorize(signal: AbortSignal): Promise<string> {
		if (signal.aborted) throw new System1Error("timeout");
		let rejectAuthTimeout: (error: System1Error) => void = () => {};
		const onAuthTimeout = (): void => rejectAuthTimeout(new System1Error("timeout"));
		const authTimeout = new Promise<never>((_resolve, reject) => {
			rejectAuthTimeout = reject;
			signal.addEventListener("abort", onAuthTimeout, { once: true });
		});
		try {
			const token = await Promise.race([this.auth(), authTimeout]);
			if (!token.trim() || /[\r\n]/.test(token)) throw new System1Error("auth");
			return token;
		} catch (err) {
			if (err instanceof System1Error) throw err;
			throw new System1Error("auth");
		} finally {
			signal.removeEventListener("abort", onAuthTimeout);
		}
	}

	private async attempt(
		body: string,
		questionIds: readonly string[],
		token: string,
		timeoutMs: number,
		parent: AbortSignal,
	): Promise<System1Decision> {
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		parent.addEventListener("abort", abort, { once: true });
		const timeout = after(timeoutMs, "system1 attempt timeout", abort);
		try {
			if (parent.aborted || timeoutMs <= 0) throw new System1Error("timeout");
			const response = await fetch(this.url, {
				method: "POST",
				redirect: "error", // Never forward a credential to a redirected service.
				signal: controller.signal,
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body,
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new System1Error("http", response.status);
			}
			return this.protocol.decode(await readJson(response), questionIds);
		} catch (err) {
			if (err instanceof System1Error) throw err;
			throw new System1Error(controller.signal.aborted ? "timeout" : "transport");
		} finally {
			timeout.cancel();
			parent.removeEventListener("abort", abort);
			// Also abort a failed/oversized body after readJson releases its
			// lock, so a rejected attempt cannot stream behind the backup.
			controller.abort();
		}
	}
}
