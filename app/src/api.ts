// The /api/app/* client. Wire types come from the server source
// (src/http/app-wire.ts) — never redeclared here.
//
// One client, two doors (design/telegram.md → Mini Apps): served under
// /t/ it is the Telegram mini app and operator requests ride the
// initData-authed /api/* tails; everywhere else it is the PWA on the
// app channel's /api/app/* (bearer/trust). The chat routes exist only
// on the app door — a bug that mounts them in telegram mode fails
// loudly with 404, never silently.

import type {
	AppAttachmentResponse,
	AppConfigPatch,
	AppConfigView,
	AppConversationCreate,
	AppConversationList,
	AppConversationPatch,
	AppMessageList,
	AppNote,
	AppNoteList,
	AppNoteRewriteRequest,
	AppNoteRewriteResponse,
	AppNoteVersion,
	AppNoteVersionList,
	AppProject,
	AppProjectList,
	AppSearchResponse,
	AppStopResponse,
	AppTtsResponse,
} from "../../src/http/app-wire.ts";
import type {
	AttachmentsResponse,
	ConfigPostBody,
	ConfigResponse,
	IdentityResponse,
	LogTailResponse,
	MemoryDocDetailResponse,
	MemoryForgetResponse,
	MemoriesListResponse,
	MemoryStatusResponse,
	OperatorDelegationsResponse,
	OperatorProgramsResponse,
	OperatorStatusResponse,
	SkillFileResponse,
	SkillsResponse,
	ThinkingLevelsResponse,
} from "../../src/http/operator-wire.ts";

// sessionStorage, not localStorage — /t/ and /app/ are one origin, so
// nothing origin-scoped isolates this key from the mini app's scripts;
// the win is only that the credential dies with the tab.
const TOKEN_KEY = "goblin.appToken";

// Upgraded installs may still carry the same key in localStorage —
// the tab-scoped move never deleted it, so without an eviction the
// credential would stay persistently stored forever. Every credential
// touch removes the local copy; a read with no session value adopts it
// into this tab's session first, so the migration keeps the operator
// logged in instead of dropping them at the gate.
function evictLocalToken(): string | null {
	const legacy = localStorage.getItem(TOKEN_KEY);
	if (legacy !== null) localStorage.removeItem(TOKEN_KEY);
	return legacy;
}

export function loadToken(): string | null {
	const session = sessionStorage.getItem(TOKEN_KEY);
	const legacy = evictLocalToken();
	if (session !== null) return session;
	if (legacy === null) return null;
	sessionStorage.setItem(TOKEN_KEY, legacy);
	return legacy;
}

export function saveToken(token: string): void {
	evictLocalToken();
	sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
	evictLocalToken();
	sessionStorage.removeItem(TOKEN_KEY);
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
// when present — trust mode ignores it either way. On the telegram
// door no credential is stored: initData rides x-init-data instead,
// and the paths swap their /api/app prefix for /api (the tails are
// named identically on both doors).
export function telegramDoor(): boolean {
	// Browser: window.location. DOM-less test envs (bun's default) have no
	// window and are never on /t/ — the door is a browser-URL property.
	const pathname = typeof window === "undefined" ? "/" : window.location.pathname;
	return /^\/t(\/|$)/.test(pathname);
}

async function requestMeta<T>(
	token: string | null,
	path: string,
	init?: RequestInit,
): Promise<{ data: T; etag: string | null }> {
	const telegram = telegramDoor();
	const res = await fetch(telegram ? `/api${path.slice("/api/app".length)}` : path, {
		...init,
		headers: {
			...(telegram
				? { "x-init-data": window.Telegram?.WebApp.initData ?? "" }
				: token === null
					? {}
					: { authorization: `Bearer ${token}` }),
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
	return { data: (await res.json()) as T, etag: res.headers.get("etag") };
}

async function request<T>(token: string | null, path: string, init?: RequestInit): Promise<T> {
	return (await requestMeta<T>(token, path, init)).data;
}

export function listConversations(token: string | null): Promise<AppConversationList> {
	return request(token, "/api/app/conversations");
}

export function createConversation(
	token: string | null,
	opts?: { title?: string; projectId?: string },
): Promise<AppConversationCreate> {
	return request(token, "/api/app/conversations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(opts ?? {}),
	});
}

export function listProjects(token: string | null): Promise<AppProjectList> {
	return request(token, "/api/app/projects");
}

export function createProject(
	token: string | null,
	body: { name: string; instructions?: string; memory?: "shared" | "off"; dir?: string },
): Promise<AppProject> {
	return request(token, "/api/app/projects", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

export function getProject(token: string | null, id: string): Promise<AppProject> {
	return request(token, `/api/app/projects/${encodeURIComponent(id)}`);
}

export function patchProject(
	token: string | null,
	id: string,
	patch: {
		name?: string;
		instructions?: string;
		memory?: "shared" | "off";
		archived?: boolean;
	},
): Promise<AppProject> {
	return request(token, `/api/app/projects/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
}

// ---------- notes ----------
// The editor's etag is the rev — If-Match guards content writes;
// flag writes (pin/archive/move) go bare. A 409 carries the live note
// so "load theirs" never needs a refetch.
export class NoteConflictError extends ApiError {
	constructor(readonly note: AppNote) {
		super(409, `note is at rev ${note.rev}`);
	}
}

export function listNotes(
	token: string | null,
	filter: { project?: string; q?: string; archived?: boolean } = {},
): Promise<AppNoteList> {
	const params = new URLSearchParams();
	if (filter.project !== undefined && filter.project !== "") params.set("project", filter.project);
	if (filter.q !== undefined && filter.q !== "") params.set("q", filter.q);
	if (filter.archived === true) params.set("archived", "1");
	const q = params.toString();
	return request(token, `/api/app/notes${q === "" ? "" : `?${q}`}`);
}

export function createNote(
	token: string | null,
	body: { title: string; body?: string; projectId?: string | null },
): Promise<AppNote> {
	return request(token, "/api/app/notes", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

export function getNote(
	token: string | null,
	id: string,
): Promise<{ data: AppNote; etag: string | null }> {
	return requestMeta(token, `/api/app/notes/${encodeURIComponent(id)}`);
}

export async function patchNote(
	token: string | null,
	id: string,
	patch: {
		title?: string;
		body?: string;
		projectId?: string | null;
		pinned?: boolean;
		archived?: boolean;
		// 'rewrite' marks the accepted proposal so the version names it.
		source?: "app" | "rewrite";
	},
	// keepalive: the pagehide flush — best effort that the request
	// outlives the page, never a guarantee. Browsers cap keepalive
	// bytes at their own discretion, so past the portable 64KiB bound
	// the request goes as an ordinary fetch and the durable draft
	// carries the edit.
	opts: { ifMatch?: number; keepalive?: boolean } = {},
): Promise<{ data: AppNote; etag: string | null }> {
	const payload = JSON.stringify(patch);
	const keepalive =
		opts.keepalive === true && new TextEncoder().encode(payload).byteLength <= 64 * 1024;
	const res = await fetch(`/api/app/notes/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: {
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
			"content-type": "application/json",
			...(opts.ifMatch !== undefined ? { "if-match": `"${opts.ifMatch}"` } : {}),
		},
		body: payload,
		...(keepalive ? { keepalive: true } : {}),
	});
	return decodeNoteMutation(res);
}

// Every note mutation that can conflict decodes the same way: a 409
// carries the live note so the page's conflict bar never refetches.
async function decodeNoteMutation(res: Response): Promise<{ data: AppNote; etag: string | null }> {
	if (res.status === 409) {
		const body = (await res.json()) as { note: AppNote };
		throw new NoteConflictError(body.note);
	}
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
	return { data: (await res.json()) as AppNote, etag: res.headers.get("etag") };
}

export function appendNote(token: string | null, id: string, text: string): Promise<AppNote> {
	return request(token, `/api/app/notes/${encodeURIComponent(id)}/append`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
}

// The rewrite POST generates only — the proposal returns through the
// guarded PATCH with source 'rewrite' (design/projects.md → AI rewrite).
export function rewriteNote(
	token: string | null,
	id: string,
	input: AppNoteRewriteRequest,
	opts: { signal?: AbortSignal } = {},
): Promise<AppNoteRewriteResponse> {
	return request(token, `/api/app/notes/${encodeURIComponent(id)}/rewrite`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
		...(opts.signal !== undefined ? { signal: opts.signal } : {}),
	});
}

export function deleteNote(token: string | null, id: string): Promise<{ ok: true }> {
	return request(token, `/api/app/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listNoteVersions(token: string | null, id: string): Promise<AppNoteVersionList> {
	return request(token, `/api/app/notes/${encodeURIComponent(id)}/versions`);
}

export function getNoteVersion(
	token: string | null,
	id: string,
	rev: number,
): Promise<AppNoteVersion> {
	return request(token, `/api/app/notes/${encodeURIComponent(id)}/versions/${rev}`);
}

// Restore is a content write — expectedRev is the caller's live rev,
// sent as If-Match so a stale panel conflicts instead of rolling a
// newer body back.
export async function restoreNoteVersion(
	token: string | null,
	id: string,
	rev: number,
	expectedRev: number,
): Promise<AppNote> {
	const res = await fetch(`/api/app/notes/${encodeURIComponent(id)}/versions/${rev}/restore`, {
		method: "POST",
		headers: {
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
			"if-match": `"${expectedRev}"`,
		},
	});
	return (await decodeNoteMutation(res)).data;
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

// ---------- operator surface ----------
// The settings editor + memories browser + read-only lists — the mini
// app's /api/* console under this door's auth. `/api/app/config` is the
// composer's app-defaults route; the full editor rides /api/app/settings.

/** GET /api/app/settings — the config, the kind lists, and its etag. */
export function getOperatorConfig(
	token: string | null,
): Promise<{ data: ConfigResponse; etag: string | null }> {
	return requestMeta(token, "/api/app/settings");
}

/** POST /api/app/settings — the full form body, guarded by If-Match. */
export function saveOperatorConfig(
	token: string | null,
	body: ConfigPostBody,
	ifMatch: string,
): Promise<{ data: { ok: true }; etag: string | null }> {
	return requestMeta(token, "/api/app/settings", {
		method: "POST",
		headers: { "content-type": "application/json", "if-match": ifMatch },
		body: JSON.stringify(body),
	});
}

/** The rungs a model can express — kind + base from the form's own state. */
export function getThinkingLevels(
	token: string | null,
	kind: string,
	model: string,
	base?: string,
): Promise<ThinkingLevelsResponse> {
	const q =
		`kind=${encodeURIComponent(kind)}&model=${encodeURIComponent(model)}` +
		(base !== undefined && base !== "" ? `&base=${encodeURIComponent(base)}` : "");
	return request(token, `/api/app/thinking-levels?${q}`);
}

export function getMemoryStatus(token: string | null): Promise<MemoryStatusResponse> {
	return request(token, "/api/app/memory/status");
}

export function listMemoryDocuments(
	token: string | null,
	opts: { q?: string; limit?: number; offset?: number } = {},
): Promise<MemoriesListResponse> {
	const params = new URLSearchParams();
	if (opts.q !== undefined && opts.q !== "") params.set("q", opts.q);
	if (opts.limit !== undefined) params.set("limit", String(opts.limit));
	if (opts.offset !== undefined) params.set("offset", String(opts.offset));
	const q = params.toString();
	return request(token, `/api/app/memory/documents${q === "" ? "" : `?${q}`}`);
}

export function getMemoryDocument(
	token: string | null,
	id: string,
): Promise<MemoryDocDetailResponse> {
	return request(token, `/api/app/memory/documents/${encodeURIComponent(id)}`);
}

export function forgetMemoryDocument(
	token: string | null,
	id: string,
): Promise<MemoryForgetResponse> {
	return request(token, `/api/app/memory/documents/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}

export function listPrograms(token: string | null): Promise<OperatorProgramsResponse> {
	return request(token, "/api/app/programs");
}

export function listDelegations(token: string | null): Promise<OperatorDelegationsResponse> {
	return request(token, "/api/app/delegations");
}

export function getServiceStatus(token: string | null): Promise<OperatorStatusResponse> {
	return request(token, "/api/app/status");
}

export function listSkills(token: string | null): Promise<SkillsResponse> {
	return request(token, "/api/app/skills");
}

export function getSkillFile(
	token: string | null,
	origin: "skills" | "proposed",
	name: string,
	path: string,
): Promise<SkillFileResponse> {
	const q = new URLSearchParams({ origin, name, path });
	return request(token, `/api/app/skills/file?${q.toString()}`);
}

export function listAttachments(token: string | null): Promise<AttachmentsResponse> {
	return request(token, "/api/app/attachments");
}

export function getIdentity(token: string | null): Promise<IdentityResponse> {
	return request(token, "/api/app/identity");
}

export function tailLog(
	token: string | null,
	opts: { limit: number; level: string | null; q: string | null },
): Promise<LogTailResponse> {
	const q = new URLSearchParams({ limit: String(opts.limit) });
	if (opts.level !== null) q.set("level", opts.level);
	if (opts.q !== null) q.set("q", opts.q);
	return request(token, `/api/app/log?${q.toString()}`);
}

// Attachments are bytes, not JSON — same door rewrite and auth headers
// as requestMeta, but a blob body. Only the PWA's Files view calls it.
export async function fetchAttachment(token: string | null, name: string): Promise<Blob> {
	const telegram = telegramDoor();
	const tail = telegram
		? `/api/attachments/file?name=${encodeURIComponent(name)}`
		: `/api/app/attachments/file?name=${encodeURIComponent(name)}`;
	const res = await fetch(tail, {
		headers: telegram
			? { "x-init-data": window.Telegram?.WebApp.initData ?? "" }
			: token === null
				? {}
				: { authorization: `Bearer ${token}` },
	});
	if (!res.ok) throw new ApiError(res.status, `http ${res.status}`);
	return res.blob();
}
