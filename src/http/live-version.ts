import { APP_LIVE_VERSION_HEADER, type AppLiveVersions } from "./app-live-topics.ts";

function hashText(text: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(text);
	return hasher.digest("hex").slice(0, 16);
}

export function versionOf(value: unknown): string {
	return hashText(JSON.stringify(value) ?? "null");
}

export function versionedJson(body: unknown, versioned: unknown = body): Response {
	const text = JSON.stringify(body);
	const version = versioned === body ? hashText(text) : versionOf(versioned);
	return new Response(text, {
		headers: {
			"content-type": "application/json;charset=utf-8",
			"cache-control": "no-store",
			[APP_LIVE_VERSION_HEADER]: version,
		},
	});
}

export interface AppLive {
	subscribe(listener: (versions: AppLiveVersions) => void): {
		versions: AppLiveVersions;
		unsubscribe(): void;
	};
}
