// Test support only — only *.test.ts files import this directory.
//
// Records one real model stream into a JSON cassette, then replays it
// so the suite can check the code around a tool call without a model.
// The request hash pins prompt + tools + toolChoice (providerOptions
// stripped at every depth): a changed prompt or tool description fails
// replay on purpose and the error names the re-record command. Recordings
// are public — never record private prompts or credentials.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4StreamPart,
	LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { z } from "zod";

export class StaleRecordingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StaleRecordingError";
	}
}

// Canonical JSON: object keys sorted recursively, undefined object
// values dropped (JSON.stringify parity), providerOptions removed at
// every depth — provider knobs like reasoning effort must not stale a
// recording. Nothing else from the call options enters the hash.
function canonical(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([k, v]) => k !== "providerOptions" && v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function requestHash(options: LanguageModelV4CallOptions): string {
	return createHash("sha256")
		.update(
			canonical({
				prompt: options.prompt,
				tools: options.tools,
				toolChoice: options.toolChoice,
			}),
		)
		.digest("hex");
}

const SCRUBBED_USAGE: LanguageModelV4Usage = {
	inputTokens: {
		total: undefined,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function stripMeta<P extends { providerMetadata?: unknown }>(part: P): P {
	const { providerMetadata: _dropped, ...rest } = part;
	return rest as P;
}

// Only these parts may reach a cassette; reasoning and response
// metadata never do, providerMetadata is stripped everywhere, stream
// warnings are forced empty, and finish usage is replaced so no account
// usage is saved. Record and replay emit exactly these kept parts.
function cleanPart(part: LanguageModelV4StreamPart): LanguageModelV4StreamPart | null {
	switch (part.type) {
		case "stream-start":
			return { ...part, warnings: [] };
		case "text-start":
		case "text-delta":
		case "text-end":
		case "tool-input-start":
		case "tool-input-delta":
		case "tool-input-end":
		case "tool-call":
			return stripMeta(part);
		case "finish":
			return { ...stripMeta(part), usage: SCRUBBED_USAGE };
		default:
			return null;
	}
}

function substitutePart(
	part: LanguageModelV4StreamPart,
	substitute: Record<string, string> | undefined,
): LanguageModelV4StreamPart {
	if (substitute === undefined) return part;
	const entries = Object.entries(substitute);
	if (entries.length === 0) return part;
	const sub = (s: string): string => {
		let out = s;
		for (const [from, to] of entries) out = out.replaceAll(from, to);
		return out;
	};
	if (part.type === "tool-call") return { ...part, input: sub(part.input) };
	if (part.type === "tool-input-delta") return { ...part, delta: sub(part.delta) };
	return part;
}

function emit(parts: LanguageModelV4StreamPart[], substitute?: Record<string, string>) {
	return new ReadableStream<LanguageModelV4StreamPart>({
		start(controller) {
			for (const part of parts) controller.enqueue(substitutePart(part, substitute));
			controller.close();
		},
	});
}

// The schema pins the part discriminator and the scalar fields the
// emitter substitutes or the SDK requires; every other field is
// provider payload passed through verbatim, so the cast is the
// cassette's own format contract, not a guess.
const partSchema = z.discriminatedUnion("type", [
	z.looseObject({ type: z.literal("stream-start") }),
	z.looseObject({ type: z.literal("text-start"), id: z.string() }),
	z.looseObject({ type: z.literal("text-delta"), id: z.string(), delta: z.string() }),
	z.looseObject({ type: z.literal("text-end"), id: z.string() }),
	z.looseObject({
		type: z.literal("tool-input-start"),
		id: z.string(),
		toolName: z.string(),
	}),
	z.looseObject({ type: z.literal("tool-input-delta"), id: z.string(), delta: z.string() }),
	z.looseObject({ type: z.literal("tool-input-end"), id: z.string() }),
	z.looseObject({
		type: z.literal("tool-call"),
		toolCallId: z.string(),
		toolName: z.string(),
		input: z.string(),
	}),
	z.looseObject({
		type: z.literal("finish"),
		finishReason: z.looseObject({ unified: z.string() }),
		usage: z.record(z.string(), z.unknown()),
	}),
]);

const cassetteSchema = z.object({
	version: z.literal(1),
	model: z.string(),
	requestHash: z.string(),
	parts: z.array(partSchema),
});

function stale(path: string, rerecord: string, why: string): StaleRecordingError {
	return new StaleRecordingError(
		`model recording ${path} is stale (${why}) — re-record with: ${rerecord}`,
	);
}

function readCassette(path: string, rerecord: string, hash: string): LanguageModelV4StreamPart[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw stale(path, rerecord, "no recording — run the test once in record mode");
		}
		throw err;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(
			`model recording ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const parsed = cassetteSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`model recording ${path} is invalid: ${parsed.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ")}`,
		);
	}
	if (parsed.data.requestHash !== hash) {
		throw stale(path, rerecord, "the request changed since it was recorded");
	}
	return parsed.data.parts as unknown as LanguageModelV4StreamPart[];
}

export function recordedModel(opts: {
	// Cassette file the recording lives in.
	path: string;
	// Command named in every stale error so a failure prints its own fix.
	rerecord: string;
	// Applied to emitted tool-call input and tool-input deltas only —
	// recordings keep the original text.
	substitute?: Record<string, string>;
	// Set = call this and save what it streams; unset = replay only.
	record?: LanguageModelV4;
}): LanguageModelV4 {
	const inner = opts.record;
	return {
		specificationVersion: "v4",
		provider: inner?.provider ?? "replay",
		modelId: inner?.modelId ?? "replay",
		supportedUrls: {},
		async doGenerate(): Promise<never> {
			throw new Error("model-replay: only doStream is supported");
		},
		async doStream(options: LanguageModelV4CallOptions) {
			const hash = requestHash(options);
			if (inner !== undefined) {
				const { stream } = await inner.doStream(options);
				const reader = stream.getReader();
				const kept: LanguageModelV4StreamPart[] = [];
				let sawFinish = false;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					// A failed stream is not a recording: throw before the
					// cassette write so a broken response can never replay.
					if (value.type === "error") {
						throw new Error(
							`model recording ${opts.path}: inner stream emitted an error part: ${
								value.error instanceof Error
									? value.error.message
									: (JSON.stringify(value.error) ?? String(value.error))
							}`,
						);
					}
					const part = cleanPart(value);
					if (part !== null) {
						if (part.type === "finish") sawFinish = true;
						kept.push(part);
					}
				}
				if (!sawFinish) {
					throw new Error(`model recording ${opts.path}: inner stream ended without a finish part`);
				}
				mkdirSync(dirname(opts.path), { recursive: true });
				writeFileSync(
					opts.path,
					`${JSON.stringify(
						{ version: 1, model: inner.modelId, requestHash: hash, parts: kept },
						null,
						2,
					)}\n`,
				);
				return { stream: emit(kept, opts.substitute) };
			}
			return { stream: emit(readCassette(opts.path, opts.rerecord, hash), opts.substitute) };
		},
	};
}
