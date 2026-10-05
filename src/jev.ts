// Jev boundary: the OpenRouter Decisions API (alpha), the gate behind
// DESIGN.md's Skill reviewer. One primary POST, at most one backup; typed
// yes/no (noul) questions about the turn's state, calibrated
// probabilities back. Wire contract: POST {baseUrl}/api/alpha/decisions
// with {model, state, questions}; answers carry {type, noul}, usage
// carries input_tokens/output_tokens/cost. Pinned by jev.test.ts
// against the documented response shape.
//
// Consumers log their routing/verdict; this boundary logs the selected
// model and recovery under one request id, never input text or secrets.

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { log } from "./log.ts";

export const JEV_MODEL = "typesafe/jev-1.13";
export const JEV_FALLBACK_MODEL = JEV_MODEL;
const DECISIONS_PATH = "/api/alpha/decisions";

type FailureKind = "http" | "transport" | "timeout" | "protocol" | "auth";

export class JevError extends Error {
	constructor(
		readonly kind: FailureKind,
		readonly status?: number,
	) {
		// No server bodies, auth-command output, fetch errors, or URLs in errors.
		super(`Jev ${kind} failure${status === undefined ? "" : ` (HTTP ${status})`}`);
		this.name = "JevError";
	}
}

// The only question type the gate asks. Both criteria are required —
// the OpenRouter transport rejects a noul carrying only one side.
export interface JevQuestion {
	type: "noul";
	instructions: string;
	criteria: { true: string; false: string };
}

const noulAnswerSchema = z.object({
	type: z.literal("noul"),
	noul: z.number().min(0).max(1),
});

const decisionsResponseSchema = z.object({
	answers: z.record(z.string(), z.unknown()),
	usage: z
		.object({
			input_tokens: z.number().optional(),
			output_tokens: z.number().optional(),
			cost: z.number().optional(),
		})
		.optional(),
});

export interface JevDecision {
	/** Asked question id → yes-probability. */
	answers: Record<string, number>;
	inputTokens: number | null;
	cost: number | null;
}

const MAX_RESPONSE_BYTES = 1_048_576;

async function readJson(response: Response): Promise<unknown> {
	if (!response.body) throw new JevError("protocol");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) throw new JevError("protocol");
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const text = Buffer.concat(chunks).toString("utf8");
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new JevError("protocol");
	}
}

export class JevClient {
	private readonly url: string;
	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly auth: () => Promise<string>;

	constructor(options: {
		baseUrl?: string;
		model?: string;
		timeoutMs?: number;
		auth: () => Promise<string>;
	}) {
		this.url = `${(options.baseUrl ?? "https://openrouter.ai").replace(/\/+$/, "")}${DECISIONS_PATH}`;
		this.model = options.model ?? JEV_MODEL;
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.auth = options.auth;
	}

	async decide(
		state: unknown,
		questions: Record<string, JevQuestion>,
		options: { timeoutMs?: number } = {},
	): Promise<JevDecision> {
		// Serialize once before any await: a fallback must see exactly the
		// same input, even if the caller mutates it during the first call.
		// Serialization failures are programming errors, not transport failures.
		const input = JSON.stringify({ state, questions });
		const questionIds = Object.keys(questions);
		const requestId = randomUUID();
		const inputHash = createHash("sha256").update(input).digest("hex").slice(0, 16);
		const timeoutMs = Math.min(this.timeoutMs, options.timeoutMs ?? this.timeoutMs);
		const started = performance.now();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		const remaining = (): number => Math.max(0, timeoutMs - (performance.now() - started));
		let model = this.model;
		try {
			const token = await this.authorize(controller.signal);
			const canFallback = this.model !== JEV_FALLBACK_MODEL;
			const attempt = (attemptModel: string, budgetMs: number): Promise<JevDecision> => {
				log.info("system1 request", {
					requestId, model: attemptModel, fallback: attemptModel !== this.model,
					questionIds, inputHash, timeoutMs: Math.floor(budgetMs),
				});
				// input is a serialized object. Insert only the model field;
				// all state/question bytes remain identical across attempts.
				const body = `{"model":${JSON.stringify(attemptModel)},${input.slice(1)}`;
				return this.attempt(body, questionIds, token, budgetMs, controller.signal);
			};
			let decision: JevDecision;
			try {
				decision = await attempt(model, remaining() / (canFallback ? 2 : 1));
			} catch (err) {
				if (
					!(err instanceof JevError) ||
					!canFallback ||
					err.kind === "auth" ||
					err.status === 401 ||
					err.status === 403 ||
					controller.signal.aborted ||
					remaining() <= 0
				) throw err;
				log.warn("system1 fallback", {
					requestId, model, fallbackModel: JEV_FALLBACK_MODEL,
					kind: err.kind, status: err.status ?? null,
					ms: Math.round(performance.now() - started),
				});
				model = JEV_FALLBACK_MODEL;
				decision = await attempt(model, remaining());
			}
			log.info("system1 decision", {
				requestId, model, fallback: model !== this.model,
				answers: decision.answers, inputTokens: decision.inputTokens, cost: decision.cost,
				ms: Math.round(performance.now() - started),
			});
			return decision;
		} catch (err) {
			if (err instanceof JevError) {
				log.warn("system1 failed", {
					requestId, model, fallback: model !== this.model,
					kind: err.kind, status: err.status ?? null,
					ms: Math.round(performance.now() - started),
				});
			}
			throw err;
		} finally {
			clearTimeout(timeout);
			controller.abort();
		}
	}

	private async authorize(signal: AbortSignal): Promise<string> {
		if (signal.aborted) throw new JevError("timeout");
		let rejectAuthTimeout: (error: JevError) => void = () => {};
		const onAuthTimeout = (): void => rejectAuthTimeout(new JevError("timeout"));
		const authTimeout = new Promise<never>((_resolve, reject) => {
			rejectAuthTimeout = reject;
			signal.addEventListener("abort", onAuthTimeout, { once: true });
		});
		try {
			const token = await Promise.race([this.auth(), authTimeout]);
			if (!token.trim() || /[\r\n]/.test(token)) throw new JevError("auth");
			return token;
		} catch (err) {
			if (err instanceof JevError) throw err;
			throw new JevError("auth");
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
	): Promise<JevDecision> {
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		parent.addEventListener("abort", abort, { once: true });
		const timeout = setTimeout(abort, timeoutMs);
		try {
			if (parent.aborted || timeoutMs <= 0) throw new JevError("timeout");
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
				throw new JevError("http", response.status);
			}
			const parsed = decisionsResponseSchema.safeParse(await readJson(response));
			if (!parsed.success) throw new JevError("protocol");
			const answers: Record<string, number> = {};
			for (const id of questionIds) {
				const answer = noulAnswerSchema.safeParse(parsed.data.answers[id]);
				if (!answer.success) throw new JevError("protocol");
				answers[id] = answer.data.noul;
			}
			return {
				answers,
				inputTokens: parsed.data.usage?.input_tokens ?? null,
				cost: parsed.data.usage?.cost ?? null,
			};
		} catch (err) {
			if (err instanceof JevError) throw err;
			throw new JevError(controller.signal.aborted ? "timeout" : "transport");
		} finally {
			clearTimeout(timeout);
			parent.removeEventListener("abort", abort);
			// Also abort a failed/oversized body after readJson releases its
			// lock, so a rejected attempt cannot stream behind the backup.
			controller.abort();
		}
	}
}
