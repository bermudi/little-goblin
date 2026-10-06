// api.z.ai's Responses endpoint streams chain-of-thought as
// `response.reasoning_text.*` events inside `reasoning_text` content
// parts — the spec's raw-CoT arm (OpenAI added reasoning_text for
// gpt-oss). @ai-sdk/openai's stream schema only models the summary arm
// (`response.reasoning_summary_*`, which hosted OpenAI models emit);
// reasoning_text isn't in its zod union as of 4.0.83, so unmodeled
// events fall through the catchall and reasoning parts land with empty
// text (probe-verified 2026-10-01 — 426 reasoning_text deltas per turn,
// all dropped; stored part carried text:"").
//
// This fetch shim rewrites raw-CoT events into summary events on the
// way in, so reasoning text streams (and persists) verbatim. Scoped to
// api.z.ai hosts — hosted OpenAI emits summaries, not reasoning_text.
//
//   z.ai event                                   →  spec event
//   content_part.added  (part: reasoning_text)   →  reasoning_summary_part.added
//   reasoning_text.delta                         →  reasoning_summary_text.delta
//   reasoning_text.done                          →  reasoning_summary_part.done
//   content_part.done   (part: reasoning_text)   →  reasoning_summary_part.done
//
// z.ai's `content_index` becomes `summary_index` (0 in practice — the
// SDK pre-creates index 0 on output_item.added, so ids join up).

interface SseData {
	type?: string;
	item_id?: string;
	output_index?: number;
	content_index?: number;
	delta?: string;
	part?: { type?: string; text?: string };
	[key: string]: unknown;
}

// Translated output is a fresh spec-shape object — a plain record, not
// an SseData (exactOptionalPropertyTypes won't let possibly-undefined
// fields land in optional slots, and JSON.stringify drops them anyway).
function translate(data: SseData): Record<string, unknown> | null {
	const { item_id, output_index, content_index } = data;
	switch (data.type) {
		case "response.reasoning_text.delta":
			return {
				type: "response.reasoning_summary_text.delta",
				item_id,
				output_index,
				summary_index: content_index ?? 0,
				delta: data.delta ?? "",
			};
		case "response.reasoning_text.done":
			return {
				type: "response.reasoning_summary_part.done",
				item_id,
				output_index,
				summary_index: content_index ?? 0,
			};
		case "response.content_part.added":
			if (data.part?.type !== "reasoning_text") return null;
			return {
				type: "response.reasoning_summary_part.added",
				item_id,
				output_index,
				summary_index: content_index ?? 0,
			};
		case "response.content_part.done":
			if (data.part?.type !== "reasoning_text") return null;
			return {
				type: "response.reasoning_summary_part.done",
				item_id,
				output_index,
				summary_index: content_index ?? 0,
			};
		default:
			return null;
	}
}

// One SSE event block → (possibly rewritten) wire text. A null return
// means "pass through verbatim". Parse failures pass through — a line
// we can't read is the provider's problem, not ours to mangle further.
function rewriteEvent(block: string): string {
	const dataLines: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
	}
	if (dataLines.length === 0) return block;
	const raw = dataLines.join("\n");
	if (raw === "[DONE]") return block;
	let parsed: SseData;
	try {
		parsed = JSON.parse(raw) as SseData;
	} catch {
		return block;
	}
	const translated = translate(parsed);
	if (translated === null) return block;
	return `event: ${translated.type}\ndata: ${JSON.stringify(translated)}`;
}

function zaiReasoningRewrite(): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buf = "";
	return new TransformStream({
		transform(chunk, controller) {
			buf += decoder.decode(chunk, { stream: true });
			// SSE events end at a blank line; anything after the last
			// boundary may be a partial event — hold it for the next chunk.
			let idx: number;
			while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
				const block = buf.slice(0, idx);
				const sep = buf.match(/\r?\n\r?\n/)![0];
				buf = buf.slice(idx + sep.length);
				controller.enqueue(encoder.encode(`${rewriteEvent(block)}${sep}`));
			}
		},
		flush(controller) {
			buf += decoder.decode();
			if (buf.length > 0) controller.enqueue(encoder.encode(rewriteEvent(buf)));
		},
	});
}

export function isZaiHost(baseUrl?: string): boolean {
	if (!baseUrl) return false;
	try {
		return new URL(baseUrl).hostname === "api.z.ai";
	} catch {
		return false;
	}
}

// Fetch middleware for createOpenAI's `fetch` option: taps only
// text/event-stream responses; JSON and errors pass through untouched.
// `typeof fetch` here is Bun's — it carries a `preconnect` member the
// SDK's FetchFunction type demands, so the wrapper delegates it rather
// than casting it away.
export function zaiReasoningFetch(
	baseFetch: (...args: Parameters<typeof fetch>) => Promise<Response> = fetch,
): typeof fetch {
	const wrapped = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	): Promise<Response> => {
		const res = await baseFetch(input, init);
		const contentType = res.headers.get("content-type") ?? "";
		if (res.body === null || !contentType.includes("text/event-stream")) return res;
		return new Response(res.body.pipeThrough(zaiReasoningRewrite()), {
			status: res.status,
			statusText: res.statusText,
			headers: res.headers,
		});
	};
	return Object.assign(wrapped, { preconnect: fetch.preconnect });
}
