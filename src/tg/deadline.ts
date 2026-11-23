import { after } from "../timing.ts";

// Bounded Telegram API calls. Grammy's only knob is a client-wide
// `timeoutSeconds` defaulting to 500s — long enough for a hung-but-alive
// connection to stall whatever serial path the call sits on.
//
// A timed-out call is abandoned, not cancelled — the underlying fetch may
// still complete: a send timeout never proves Telegram didn't deliver.

export const API_CALL_TIMEOUT_MS = 30_000;

export class TelegramTimeoutError extends Error {
	constructor(
		readonly label: string,
		readonly ms: number,
	) {
		super(`${label} timed out after ${ms}ms`);
		this.name = "TelegramTimeoutError";
	}
}

export function withTimeout<T>(p: Promise<T>, label: string, ms = API_CALL_TIMEOUT_MS): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = after(
			ms,
			`telegram ${label} timeout`,
			() => reject(new TelegramTimeoutError(label, ms)),
			{ unref: true },
		);
		p.then(
			(v) => {
				t.cancel();
				resolve(v);
			},
			(e: unknown) => {
				t.cancel();
				reject(e instanceof Error ? e : new Error(String(e)));
			},
		);
	});
}
