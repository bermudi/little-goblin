import { expect, test } from "bun:test";
import { APICallError } from "ai";
import { ProviderError } from "./provider-errors.ts";
import { fromSdkError } from "./sdk-errors.ts";

function apiCallError(): APICallError {
	return new APICallError({
		message: "Service Unavailable",
		url: "https://provider.test/v1/responses",
		requestBodyValues: {},
		statusCode: 503,
		responseBody: "upstream overloaded",
	});
}

test("a converted SDK error keeps the original stack and its facts", () => {
	const original = apiCallError();
	const converted = fromSdkError(original);
	expect(converted).toBeInstanceOf(ProviderError);
	expect((converted as ProviderError).status).toBe(503);
	expect((converted as ProviderError).stack).toBe(original.stack);
});

test("a plain error wrapping an SDK error keeps the wrapper's stack", () => {
	const wrapper = new Error("title generation failed", { cause: apiCallError() });
	const converted = fromSdkError(wrapper) as ProviderError;
	expect(converted).toBeInstanceOf(ProviderError);
	expect(converted.stack).toBe(wrapper.stack);
	expect((converted.cause as ProviderError).status).toBe(503);
});
