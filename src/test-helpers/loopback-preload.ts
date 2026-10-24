// Child-process preload for boot tests: block every non-loopback fetch so
// a spawned index.ts can never reach the real network (the models.dev and
// openrouter catalog warmers are fire-and-forget). Blocked URLs land in
// $GOBLIN_BOOTPROBE_BLOCKED for the parent to inspect.
import { appendFileSync } from "node:fs";

const LOG = process.env.GOBLIN_BOOTPROBE_BLOCKED ?? "/dev/null";
const orig = globalThis.fetch;

function isLoopback(url: URL): boolean {
	const h = url.hostname;
	return (
		h === "127.0.0.1" ||
		h === "localhost" ||
		h === "::1" ||
		h === "[::1]" ||
		h.endsWith(".localhost")
	);
}

globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
	let url: URL;
	try {
		url = new URL(
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
		);
	} catch {
		return Promise.reject(new Error("boot probe: unparseable fetch url"));
	}
	if (!isLoopback(url)) {
		try {
			appendFileSync(LOG, `${new Date().toISOString()} BLOCKED ${url.href}\n`);
		} catch {}
		return Promise.reject(new Error(`boot probe: non-loopback fetch blocked: ${url.href}`));
	}
	return orig(input, init);
}) as typeof fetch;
