// Jev boundary: the OpenRouter Decisions API (alpha), the gate behind
// DESIGN.md's Skill reviewer. One POST per completed turn; typed
// yes/no (noul) questions about the turn's state, calibrated
// probabilities back. Wire contract: POST {baseUrl}/api/alpha/decisions
// with {model, state, questions}; answers carry {type, noul}, usage
// carries input_tokens/output_tokens/cost. Pinned by jev.test.ts
// against the documented response shape.
//
// The client never logs: the reviewer's gate line is the boundary
// record for the call (probabilities, decision, tokens, cost,
// latency) on every outcome, success or fallback.

import { z } from "zod";

export const JEV_MODEL = "respan/span-01-lite";
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

	async decide(state: unknown, questions: Record<string, JevQuestion>): Promise<JevDecision> {
		const controller = new AbortController();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.timeoutMs);
		try {
			let token: string;
			const onAuthTimeout = (): void => rejectAuthTimeout(new JevError("timeout"));
			let rejectAuthTimeout: (error: JevError) => void = () => {};
			const authTimeout = new Promise<never>((_resolve, reject) => {
				rejectAuthTimeout = reject;
				controller.signal.addEventListener("abort", onAuthTimeout, { once: true });
			});
			try {
				token = await Promise.race([this.auth(), authTimeout]);
				if (!token.trim() || /[\r\n]/.test(token)) throw new Error("invalid auth");
			} catch (err) {
				if (err instanceof JevError) throw err;
				throw new JevError("auth");
			} finally {
				controller.signal.removeEventListener("abort", onAuthTimeout);
			}
			if (controller.signal.aborted) throw new JevError(timedOut ? "timeout" : "transport");
			let response: Response;
			try {
				response = await fetch(this.url, {
					method: "POST",
					redirect: "error", // Never forward a credential to a redirected service.
					signal: controller.signal,
					headers: {
						accept: "application/json",
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({ model: this.model, state, questions }),
				});
			} catch {
				// The only abort source is our own timeout — anything else is
				// the network failing before a response existed.
				throw new JevError(timedOut || controller.signal.aborted ? "timeout" : "transport");
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new JevError("http", response.status);
			}
			let body: unknown;
			try {
				body = await readJson(response);
			} catch (err) {
				if (err instanceof JevError) throw err;
				throw new JevError(timedOut ? "timeout" : "transport");
			}
			const parsed = decisionsResponseSchema.safeParse(body);
			if (!parsed.success) throw new JevError("protocol");
			const answers: Record<string, number> = {};
			for (const id of Object.keys(questions)) {
				const answer = noulAnswerSchema.safeParse(parsed.data.answers[id]);
				if (!answer.success) throw new JevError("protocol");
				answers[id] = answer.data.noul;
			}
			return {
				answers,
				inputTokens: parsed.data.usage?.input_tokens ?? null,
				cost: parsed.data.usage?.cost ?? null,
			};
		} finally {
			clearTimeout(timeout);
		}
	}
}
