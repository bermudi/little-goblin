// Telegram WebApp initData validation. The page is fetched by the client
// device, so the query-string credentials Telegram appends are the only
// proof of identity: HMAC-SHA256 over the sorted data-check-string, keyed
// by HMAC("WebAppData", botToken), plus user-id allowlisting and auth_date
// freshness.

import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Small future tolerance for client clock skew; beyond that, reject.
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface InitDataUser {
	id: number;
}

// Returns the Telegram user id on success, null on any failure.
export function validateInitData(
	initData: string,
	botToken: string,
	allowedUsers: Set<number>,
): InitDataUser | null {
	const params = new URLSearchParams(initData);
	const hash = params.get("hash");
	if (!hash) return null;
	params.delete("hash");

	const checkString = [...params.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");

	const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
	const computed = createHmac("sha256", secret).update(checkString).digest("hex");
	const a = Buffer.from(computed, "utf8");
	const b = Buffer.from(hash, "utf8");
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

	const authDateMs = Number(params.get("auth_date") ?? 0) * 1000;
	if (
		!Number.isFinite(authDateMs) ||
		Date.now() - authDateMs > MAX_AGE_MS ||
		authDateMs - Date.now() > MAX_FUTURE_SKEW_MS
	) {
		return null;
	}

	const userRaw = params.get("user");
	if (!userRaw) return null;
	let id: number;
	try {
		id = (JSON.parse(userRaw) as { id?: number }).id ?? 0;
	} catch {
		return null;
	}
	if (!allowedUsers.has(id)) return null;
	return { id };
}
