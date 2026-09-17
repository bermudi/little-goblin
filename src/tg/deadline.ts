// Bounded Telegram API calls. Grammy's only knob is a client-wide
// `timeoutSeconds` defaulting to 500s — long enough for a hung-but-alive
// connection (dead proxy, wedged local bot-api) to stall whatever serial
// path the call sits on: the delivery chain's `await chain` wedges the
// conversation lane, `getFile` wedges the intake chain. Everything else
// in the codebase is bounded tighter; these edges are too.
//
// A timed-out call is abandoned, not cancelled — the underlying fetch may
// still complete, but the caller stops waiting and treats it as a failure
// (delivery retries it; intake reports the failure as a text part).

export const API_CALL_TIMEOUT_MS = 30_000;

export function withTimeout<T>(
	p: Promise<T>,
	label: string,
	ms = API_CALL_TIMEOUT_MS,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(
			() => reject(new Error(`${label} timed out after ${ms}ms`)),
			ms,
		);
		t.unref();
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e: unknown) => {
				clearTimeout(t);
				reject(e instanceof Error ? e : new Error(String(e)));
			},
		);
	});
}
