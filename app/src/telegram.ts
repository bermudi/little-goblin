// Stand-in for telegram-web-app.js, installed only when the webview
// didn't inject window.Telegram — Telegram Desktop doesn't. initData
// rides the URL hash (tgWebAppData) in every client; ready/expand post
// the same events over the same bridges the official script dispatches
// to, in its precedence order. Deliberately local: /t/ shares the
// PWA's origin and the bearer token in its localStorage, so no
// third-party bytes — fetched or pinned — run here.

// Mirrors the official parser: hash may be `#tgWebAppData=…` or
// `#<path>?tgWebAppData=…`; `+` decodes as space; undecodable parts
// stay raw (the notice path handles a missing payload).
function hashParams(hash: string): Record<string, string> {
	const raw = hash.replace(/^#/, "");
	if (!raw.includes("=") && !raw.includes("?")) return {};
	const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
	const params: Record<string, string> = {};
	for (const pair of query.split("&")) {
		const eq = pair.indexOf("=");
		if (eq < 0) continue;
		params[safeDecode(pair.slice(0, eq))] = safeDecode(pair.slice(eq + 1));
	}
	return params;
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value.replace(/\+/g, "%20"));
	} catch {
		return value;
	}
}

function unsafeUser(initData: string): { user?: { id?: number } } {
	const user = new URLSearchParams(initData).get("user");
	if (user === null) return {};
	try {
		const parsed: unknown = JSON.parse(user);
		if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) return {};
		return { user: parsed as { id?: number } };
	} catch {
		return {};
	}
}

function postEvent(eventType: string): void {
	const eventData = "";
	if (window.TelegramWebviewProxy !== undefined) {
		window.TelegramWebviewProxy.postEvent(eventType, JSON.stringify(eventData));
		return;
	}
	const external = (window as unknown as { external?: { notify?: (data: string) => void } })
		.external;
	if (external?.notify !== undefined) {
		external.notify(JSON.stringify({ eventType, eventData }));
		return;
	}
	if (window.parent !== window) {
		window.parent.postMessage(JSON.stringify({ eventType, eventData }), "*");
	}
}

// Injected SDKs win — their copy is canonical and richer than this.
export function installTelegramFallback(): void {
	if (window.Telegram !== undefined) return;
	const initData = hashParams(window.location.hash).tgWebAppData ?? "";
	window.Telegram = {
		WebApp: {
			initData,
			initDataUnsafe: unsafeUser(initData),
			ready: () => postEvent("web_app_ready"),
			expand: () => postEvent("web_app_expand"),
		},
	};
}
