import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface InitDataUser {
	id: number;
}

// The refusal categories are all logs may say: initData fragments, the
// presented hash and the claimed user id are credential material and
// never leave this function.
export type InitDataRefusal =
	| "no-hash"
	| "bad-hmac"
	| "bad-auth-date"
	| "stale"
	| "future"
	| "no-user"
	| "bad-user"
	| "not-operator";
export type InitDataResult = { ok: true; user: InitDataUser } | { ok: false; why: InitDataRefusal };

export function validateInitData(
	initData: string,
	botToken: string,
	operators: Set<number>,
): InitDataResult {
	const deny = (why: InitDataRefusal): InitDataResult => ({ ok: false, why });
	const params = new URLSearchParams(initData);
	const hash = params.get("hash");
	if (!hash) return deny("no-hash");
	params.delete("hash");

	const checkString = [...params.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");

	const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
	const computed = createHmac("sha256", secret).update(checkString).digest("hex");
	const a = Buffer.from(computed, "utf8");
	const b = Buffer.from(hash, "utf8");
	if (a.length !== b.length || !timingSafeEqual(a, b)) return deny("bad-hmac");

	const authDate = params.get("auth_date");
	const authDateMs = authDate === null ? NaN : Number(authDate) * 1000;
	if (!Number.isFinite(authDateMs)) return deny("bad-auth-date");
	if (Date.now() - authDateMs > MAX_AGE_MS) return deny("stale");
	if (authDateMs - Date.now() > MAX_FUTURE_SKEW_MS) return deny("future");

	const userRaw = params.get("user");
	if (!userRaw) return deny("no-user");
	let id: number;
	try {
		id = (JSON.parse(userRaw) as { id?: number }).id ?? 0;
	} catch {
		return deny("bad-user");
	}
	if (!operators.has(id)) return deny("not-operator");
	return { ok: true, user: { id } };
}
