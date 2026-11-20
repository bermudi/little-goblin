// The AI SDK engine's failure edge (design/model.md → Provider failure
// shape, #770): the SDK's error classes and raw provider stream-error
// payloads become goblin's ProviderError here, once, so provider-errors.ts
// sorts without knowing the SDK's field names. Values this edge does not
// own (goblin errors, platform errors like a fetch TypeError) pass through.

import { AISDKError, APICallError, RetryError } from "ai";
import {
	ProviderContentFilterError,
	ProviderError,
} from "./provider-errors.ts";

const MAX_DEPTH = 4;

function stringify(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		// Unstringifiable data contributes nothing — the message still sorts.
		return undefined;
	}
}

// APICallError carries the raw body on responseBody and, for some
// providers, the parsed one on data; both are evidence.
function apiCallBody(err: APICallError): string | undefined {
	const parts: string[] = [];
	if (err.responseBody !== undefined) parts.push(err.responseBody);
	if (err.data !== undefined) {
		const data = stringify(err.data);
		if (data !== undefined) parts.push(data);
	}
	return parts.length === 0 ? undefined : parts.join("\n");
}

export function fromSdkError(err: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH) return err;
	if (err instanceof ProviderError || err instanceof ProviderContentFilterError) return err;
	if (APICallError.isInstance(err)) {
		return new ProviderError(
			err.message,
			{ status: err.statusCode, body: apiCallBody(err) },
			{ cause: fromSdkError(err.cause, depth + 1) },
		);
	}
	if (RetryError.isInstance(err)) {
		return new AggregateError(
			err.errors.map((e) => fromSdkError(e, depth + 1)),
			err.message,
		);
	}
	if (AISDKError.isInstance(err)) {
		return err.cause === undefined
			? err
			: new ProviderError(err.message, {}, { cause: fromSdkError(err.cause, depth + 1) });
	}
	if (err instanceof Error) {
		if (err.cause instanceof Error) {
			const cause = fromSdkError(err.cause, depth + 1);
			if (cause !== err.cause) return new ProviderError(err.message, {}, { cause });
		}
		return err;
	}
	if (typeof err !== "object" || err === null) return err;
	// A provider stream error part carries the provider's own JSON (an
	// SSE error chunk, an `error`/`response` envelope): its text is the
	// evidence, whatever its fields are called.
	const message = (err as { message?: unknown }).message;
	return new ProviderError(typeof message === "string" ? message : "provider stream error", {
		body: stringify(err),
	});
}
