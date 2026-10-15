// The save-flow policy extracted from SettingsView: failure
// classification (which errors get the retry button) and the autosave
// signature gate (no chained retries on identical state).

import { describe, expect, test } from "bun:test";
import { ApiError } from "./api.ts";
import { saveFailure, shouldAutosave } from "./settingsSave.ts";

describe("saveFailure", () => {
	test("a 409 is a stale etag — reload the page, never a retry button", () => {
		const n = saveFailure(new ApiError(409, "conflict"));
		expect(n.retryable).toBe(false);
		expect(n.text).toContain("reload the page");
	});

	test("a server refusal surfaces its message and offers retry", () => {
		expect(saveFailure(new ApiError(422, "unknown provider"))).toEqual({
			text: "unknown provider",
			retryable: true,
		});
	});

	test("a network-level failure gets the tailnet line and still retries", () => {
		const n = saveFailure(new TypeError("fetch failed"));
		expect(n.retryable).toBe(true);
		expect(n.text).toContain("tailnet");
	});
});

describe("shouldAutosave", () => {
	const base = {
		dirty: true,
		invalidReason: null,
		saving: false,
		sig: "sig-1",
		attempted: null as string | null,
	};

	test("a dirty, valid, idle draft schedules one write", () => {
		expect(shouldAutosave(base)).toBe(true);
	});

	test("clean, invalid, and mid-write drafts never schedule", () => {
		expect(shouldAutosave({ ...base, dirty: false })).toBe(false);
		expect(shouldAutosave({ ...base, invalidReason: "pick a model" })).toBe(false);
		expect(shouldAutosave({ ...base, saving: true })).toBe(false);
	});

	test("an already-attempted signature doesn't re-fire — only an edit re-arms", () => {
		expect(shouldAutosave({ ...base, attempted: "sig-1" })).toBe(false);
		expect(shouldAutosave({ ...base, attempted: "sig-0" })).toBe(true);
	});
});
