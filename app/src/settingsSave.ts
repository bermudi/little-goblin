// SettingsView's save-flow policy, extracted so the debounce/etag/retry
// interplay is testable without mounting the form. Pure decisions only.

import { ApiError } from "./api.ts";

export interface SaveFailure {
	text: string;
	// Whether the savebar's retry button makes sense — a 409 is a stale
	// etag the same save retries forever; only a reload fixes it.
	retryable: boolean;
}

export function saveFailure(err: unknown): SaveFailure {
	if (err instanceof ApiError && err.status === 409) {
		return {
			text: "The config changed since this tab loaded — reload the page to see the latest.",
			retryable: false,
		};
	}
	if (err instanceof ApiError) return { text: err.message, retryable: true };
	return { text: "Save failed — check the tailnet.", retryable: true };
}

// The autosave gate: a dirty, valid, not-mid-write draft whose exact
// signature hasn't already been attempted gets one debounced write. A
// failed write isn't retried on identical state — the next edit re-arms.
export function shouldAutosave(a: {
	dirty: boolean;
	invalidReason: string | null;
	saving: boolean;
	sig: string;
	attempted: string | null;
}): boolean {
	if (!a.dirty || a.invalidReason !== null || a.saving) return false;
	return a.sig !== a.attempted;
}
