// Telegram API error classifiers, pure and stateless. Telegram exposes no
// typed codes for these cases, so each matches strings across the shapes a
// grammy error (or its wrapped payload) may carry, gated on error_code 400.

export function isPremiumGateError(err: unknown): boolean {
	const haystacks: unknown[] = [err];
	if (typeof err === "object" && err !== null) {
		const rec = err as Record<string, unknown>;
		if (rec.error_code !== undefined && rec.error_code !== 400) return false;
		haystacks.push(rec.description, rec.message);
	}
	return haystacks.some((h) => typeof h === "string" && h.includes("PREMIUM_ACCOUNT_REQUIRED"));
}

export function isNotModifiedError(err: unknown): boolean {
	const haystacks: unknown[] = [err];
	if (typeof err === "object" && err !== null) {
		const rec = err as Record<string, unknown>;
		if (rec.error_code !== undefined && rec.error_code !== 400) return false;
		haystacks.push(rec.description, rec.message);
	}
	return haystacks.some(
		(h) => typeof h === "string" && h.toLowerCase().includes("message is not modified"),
	);
}

// "can't parse entities" — a definite 400: nothing landed, so the same
// send may be retried as plain text. Never a timeout's ambiguity.
export function isParseEntitiesError(err: unknown): boolean {
	const haystacks: unknown[] = [err];
	if (typeof err === "object" && err !== null) {
		const rec = err as Record<string, unknown>;
		if (rec.error_code !== undefined && rec.error_code !== 400) return false;
		haystacks.push(rec.description, rec.message);
	}
	return haystacks.some(
		(h) => typeof h === "string" && h.toLowerCase().includes("can't parse entities"),
	);
}

export function isMessageGoneError(err: unknown): boolean {
	const haystacks: unknown[] = [err];
	if (typeof err === "object" && err !== null) {
		const rec = err as Record<string, unknown>;
		if (rec.error_code !== undefined && rec.error_code !== 400) return false;
		haystacks.push(rec.description, rec.message);
	}
	return haystacks.some(
		(h) =>
			typeof h === "string" &&
			(h.includes("message to edit not found") || h.includes("message not found")),
	);
}
