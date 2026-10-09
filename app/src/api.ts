// The /api/app/* client. Wire types come from the server source
// (src/http/app-wire.ts) — never redeclared here.

import type {
	AppAttachmentResponse,
	AppConfigPatch,
	AppConfigView,
	AppConversationCreate,
	AppConversationList,
	AppConversationPatch,
	AppMessageList,
	AppSearchResponse,
	AppStopResponse,
	AppTtsResponse,
} from "../../src/http/app-wire.ts";

const TOKEN_KEY = "goblin.appToken";

export function loadToken(): string | null {
	return localStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string): void {
	localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
	localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

// token null = trust mode: the server has no appToken, the tailnet is
// the only lock, and requests go bare. A stored token is always sent
// when present — trust mode ignores it either way.
async function request<T>(token: string | null, path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		...init,
		headers: {
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
			...(init?.headers ?? {}),
		},
	});
	if (!res.ok) {
		let detail = `http ${res.status}`;
		try {
			const body = (await res.json()) as { error?: string };
			if (body.error !== undefined) detail = body.error;
		} catch {
			/* not json */
		}
		throw new ApiError(res.status, detail);
	}
	return (await res.json()) as T;
}

export function listConversations(token: string | null): Promise<AppConversationList> {
	return request(token, "/api/app/conversations");
}

export function createConversation(
	token: string | null,
	title?: string,
): Promise<AppConversationCreate> {
	return request(token, "/api/app/conversations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(title === undefined ? {} : { title }),
	});
}

export function getMessages(token: string | null, id: string): Promise<AppMessageList> {
	return request(
		token,
		`/api/app/conversations/${encodeURIComponent(id.slice("app/".length))}/messages`,
	);
}

// /stop rides the runtime's own stop — abort the turn server-side, not
// just this client's stream (history keeps whatever the turn wrote).
export function stopConversation(token: string | null, id: string): Promise<AppStopResponse> {
	return request(
		token,
		`/api/app/conversations/${encodeURIComponent(id.slice("app/".length))}/stop`,
		{
			method: "POST",
		},
	);
}

export async function uploadAttachment(
	token: string | null,
	file: File,
): Promise<AppAttachmentResponse> {
	const form = new FormData();
	form.append("file", file, file.name);
	return request(token, "/api/app/attachments", { method: "POST", body: form });
}

// The app conversation ids are full "app/<id>" addresses — path segments
// carry the bare id only.
const seg = (id: string) => encodeURIComponent(id.slice("app/".length));

export function patchConversation(
	token: string | null,
	id: string,
	patch: AppConversationPatch,
): Promise<AppConversationPatch> {
	return request(token, `/api/app/conversations/${seg(id)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
}

export function deleteConversation(token: string | null, id: string): Promise<{ ok: true }> {
	return request(token, `/api/app/conversations/${seg(id)}`, { method: "DELETE" });
}

export function searchConversations(token: string | null, q: string): Promise<AppSearchResponse> {
	return request(token, `/api/app/search?q=${encodeURIComponent(q)}`);
}

// New-chat defaults, not an existing conversation's selection.
export function getConfig(token: string | null): Promise<AppConfigView> {
	return request(token, "/api/app/config");
}

export function patchConfig(token: string | null, patch: AppConfigPatch): Promise<AppConfigView> {
	return request(token, "/api/app/config", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
}

export function getConversationConfig(token: string | null, id: string): Promise<AppConfigView> {
	return request(token, `/api/app/conversations/${seg(id)}/config`);
}

export function patchConversationConfig(
	token: string | null,
	id: string,
	patch: AppConfigPatch,
): Promise<AppConfigView> {
	return request(token, `/api/app/conversations/${seg(id)}/config`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
}

// Read-aloud — reply text in, base64 ogg chunks out.
export function synthesize(token: string | null, text: string): Promise<AppTtsResponse> {
	return request(token, "/api/app/tts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
}
