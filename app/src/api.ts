// The /api/app/* client. Wire types come from the server source
// (src/http/app-wire.ts) — never redeclared here.

import type {
	AppAttachmentResponse,
	AppConversationCreate,
	AppConversationList,
	AppMessageList,
	AppStopResponse,
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

async function request<T>(token: string, path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		...init,
		headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
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

export function listConversations(token: string): Promise<AppConversationList> {
	return request(token, "/api/app/conversations");
}

export function createConversation(token: string, title?: string): Promise<AppConversationCreate> {
	return request(token, "/api/app/conversations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(title === undefined ? {} : { title }),
	});
}

export function getMessages(token: string, id: string): Promise<AppMessageList> {
	return request(token, `/api/app/conversations/${encodeURIComponent(id.slice("app/".length))}/messages`);
}

// /stop rides the runtime's own stop — abort the turn server-side, not
// just this client's stream (history keeps whatever the turn wrote).
export function stopConversation(token: string, id: string): Promise<AppStopResponse> {
	return request(token, `/api/app/conversations/${encodeURIComponent(id.slice("app/".length))}/stop`, {
		method: "POST",
	});
}

export async function uploadAttachment(token: string, file: File): Promise<AppAttachmentResponse> {
	const form = new FormData();
	form.append("file", file, file.name);
	return request(token, "/api/app/attachments", { method: "POST", body: form });
}
