import { describe, expect, test } from "bun:test";
import { withTimeout } from "./deadline.ts";

describe("withTimeout", () => {
	test("a settling promise passes through", async () => {
		await expect(withTimeout(Promise.resolve(42), "x")).resolves.toBe(42);
	});

	test("a hung promise rejects instead of waiting forever", async () => {
		const hung = new Promise(() => {});
		await expect(withTimeout(hung, "sendMessage", 50)).rejects.toThrow(
			"sendMessage timed out after 50ms",
		);
	});
});
