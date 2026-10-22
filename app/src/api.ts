// Wire types come from the server source (src/http/app-wire.ts) —
// never redeclared here.
//
// One client, two doors: served under /t/ it is the Telegram mini app
// and operator requests ride the initData-authed /api/* tails;
// everywhere else it is the PWA on the app channel's /api/app/*
// (bearer/trust). The chat routes exist only on the app door — a bug
// that mounts them in telegram mode fails loudly with 404, never
// silently.

import type {
	AppApprovalDecisionResponse,
	AppApprovalsResponse,
	AppAttachmentResponse,
	AppAttentionResponse,
	AppCompactResponse,
	AppConfigPatch,
	AppConfigView,
	AppContextView,
	AppConversationCreate,
	AppConversationList,
	AppConversationMemoryResponse,
	AppConversationMemoryView,
	AppConversationPatch,
	AppDecideRequest,
	AppDecideResponse,
	AppInterruptedList,
	AppInterruptedRun,
	AppMessageList,
	AppNote,
	AppNoteList,
	AppNoteRewriteRequest,
	AppNoteRewriteResponse,
	AppNoteVersion,
	AppNoteVersionList,
	AppProgramMutationResponse,
	AppProject,
	AppReplyRating,
	AppReplyRatingResponse,
	AppProjectList,
	AppCorrectRequest,
	AppPushPublicKeyResponse,
	AppPushRegisterResponse,
	AppPushStatus,
	AppPushSubscriptionRequest,
	AppPushUnregisterResponse,
	AppResponsibilityFeed,
	AppResumeResponse,
	AppRunCall,
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
	MemoryBlockedResponse,
	MemoryDocDetailResponse,
	MemoryForgetResponse,
	MemoriesListResponse,
	MemoryStatusResponse,
	OperatorDelegationsResponse,
	OperatorProgramsResponse,
	OperatorStatusResponse,
	SecretStoreResponse,
	SkillDecideBody,
	SkillDecideResponse,
	SkillFileResponse,
	SkillsResponse,
	ThinkingLevelsResponse,
	ThreadSkillsResponse,
} from "../../src/http/operator-wire.ts";
import { z } from "zod";

// sessionStorage, not localStorage — /t/ and /app/ are one origin, so
// nothing origin-scoped isolates this key from the mini app's scripts;
// the win is only that the credential dies with the tab.
const TOKEN_KEY = "goblin.appToken";

// Upgraded installs may still carry the key in localStorage — without
// an eviction the credential would stay persistently stored forever.
// Every credential touch removes the local copy; a read with no session
// value adopts it into this tab's session first, so the migration keeps
// the operator logged in instead of dropping them at the gate.
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

async function rawRequest(
	token: string | null,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	const telegram = telegramDoor();
	return fetch(telegram ? `/api${path.slice("/api/app".length)}` : path, {
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
}

async function requestMeta<T>(
	token: string | null,
	path: string,
	init?: RequestInit,
): Promise<{ data: T; etag: string | null }> {
	const res = await rawRequest(token, path, init);
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

export function listApprovals(token: string | null): Promise<AppApprovalsResponse> {
	return request(token, "/api/app/approvals");
}

export function getAttention(token: string | null): Promise<AppAttentionResponse> {
	return request(token, "/api/app/attention");
}

export function getPushStatus(token: string | null): Promise<AppPushStatus> {
	return request(token, "/api/app/push");
}

export function getPushPublicKey(token: string | null): Promise<AppPushPublicKeyResponse> {
	return request(token, "/api/app/push/public-key", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
}

export function registerPushSubscription(
	token: string | null,
	subscription: AppPushSubscriptionRequest,
): Promise<AppPushRegisterResponse> {
	return request(token, "/api/app/push/subscription", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(subscription),
	});
}

export function unregisterPushSubscription(
	token: string | null,
	endpoint: string,
): Promise<AppPushUnregisterResponse> {
	return request(token, "/api/app/push/subscription", {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ endpoint }),
	});
}

export function decideProgramApproval(
	token: string | null,
	id: number,
	action: "approve" | "reject",
): Promise<AppApprovalDecisionResponse> {
	return request(token, `/api/app/approvals/program/${id}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action }),
	});
}

export function decideMailApproval(
	token: string | null,
	id: number,
	action: "send" | "cancel",
): Promise<AppApprovalDecisionResponse> {
	return request(token, `/api/app/approvals/mail/${id}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action }),
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
	const res = await rawRequest(token, `/api/app/notes/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: {
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
// guarded PATCH with source 'rewrite'.
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

export function rateReply(
	token: string | null,
	id: string,
	messageId: string,
	rating: AppReplyRating,
): Promise<AppReplyRatingResponse> {
	return request(token, `/api/app/conversations/${seg(id)}/ratings`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messageId, rating }),
	});
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

export function getConversationMemory(
	token: string | null,
	id: string,
): Promise<AppConversationMemoryView> {
	return request(token, `/api/app/conversations/${seg(id)}/memory`);
}

export function patchConversationMemory(
	token: string | null,
	id: string,
	memoryExcluded: boolean,
): Promise<AppConversationMemoryResponse> {
	return request(token, `/api/app/conversations/${seg(id)}/memory`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ memoryExcluded }),
	});
}

// The composer's context gauge — last-turn window utilization for one
// conversation. Null fields mean unknown (no turns yet, or the catalog
// doesn't list the model), never zero.
export function getContext(token: string | null, id: string): Promise<AppContextView> {
	return request(token, `/api/app/conversations/${seg(id)}/context`);
}

const runCallSchema: z.ZodType<AppRunCall> = z.object({
	toolCallId: z.string(),
	name: z.string(),
	args: z.unknown(),
	state: z.enum([
		"planned",
		"dispatched",
		"completed",
		"failed",
		"resolved-done",
		"resolved-retry",
		"resolved-skip",
	]),
	result: z.string().nullable(),
	error: z.string().nullable(),
	resolutionNote: z.string().nullable(),
	resolvedMs: z.number().nullable(),
	canAuthorizeRetry: z.boolean(),
});

const interruptedRunSchema: z.ZodType<AppInterruptedRun> = z.object({
	runId: z.string(),
	resumedFrom: z.string().nullable(),
	startedMs: z.number(),
	finishedMs: z.number().nullable(),
	calls: z.object({
		planned: z.number(),
		dispatched: z.number(),
		completed: z.number(),
		failed: z.number(),
		resolved: z.number(),
	}),
	toolCalls: z.array(runCallSchema),
});

const interruptedListSchema: z.ZodType<AppInterruptedList> = z.object({
	runs: z.array(interruptedRunSchema),
});

const decideResponseSchema: z.ZodType<AppDecideResponse> = z.object({
	ok: z.literal(true),
});

const resumeResponseSchema: z.ZodType<AppResumeResponse> = z.object({
	resumed: z.literal(true),
	runId: z.string(),
});

export async function listInterruptedRuns(
	token: string | null,
	id: string,
): Promise<AppInterruptedList> {
	const res = await request<unknown>(token, `/api/app/conversations/${seg(id)}/interrupted`);
	const parsed = interruptedListSchema.safeParse(res);
	if (!parsed.success) throw new Error("invalid interrupted-turn list response");
	return parsed.data;
}

export async function decideRunCall(
	token: string | null,
	id: string,
	runId: string,
	body: AppDecideRequest,
): Promise<AppDecideResponse> {
	const res = await request<unknown>(
		token,
		`/api/app/conversations/${seg(id)}/runs/${encodeURIComponent(runId)}/decide`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	const parsed = decideResponseSchema.safeParse(res);
	if (!parsed.success) throw new Error("invalid decide response");
	return parsed.data;
}

export async function resumeRun(
	token: string | null,
	id: string,
	runId: string,
): Promise<AppResumeResponse> {
	const res = await request<unknown>(
		token,
		`/api/app/conversations/${seg(id)}/runs/${encodeURIComponent(runId)}/resume`,
		{ method: "POST" },
	);
	const parsed = resumeResponseSchema.safeParse(res);
	if (!parsed.success) throw new Error("invalid resume response");
	return parsed.data;
}

// The manual lever — the same lane compaction /compact runs in
// Telegram. The POST awaits the job, so a running turn finishing first
// shows up as a slow response.
export function compactConversation(token: string | null, id: string): Promise<AppCompactResponse> {
	return request(token, `/api/app/conversations/${seg(id)}/compact`, { method: "POST" });
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
// `/api/app/config` is the composer's app-defaults route; the full
// editor rides /api/app/settings.

export function getOperatorConfig(
	token: string | null,
): Promise<{ data: ConfigResponse; etag: string | null }> {
	return requestMeta(token, "/api/app/settings");
}

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

// The record resolves on the running process — no restart.
export function storeSecret(
	token: string | null,
	body: { name: string; value: string },
): Promise<SecretStoreResponse> {
	return request(token, "/api/app/secrets", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

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

export function decideBlockedMemory(
	token: string | null,
	action: "retry" | "dismiss",
): Promise<MemoryBlockedResponse> {
	return request(token, "/api/app/memory/blocked", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action }),
	});
}

export function listMemoryDocuments(
	token: string | null,
	opts: { q?: string; conversation?: string; limit?: number; offset?: number } = {},
): Promise<MemoriesListResponse> {
	const params = new URLSearchParams();
	if (opts.q !== undefined && opts.q !== "") params.set("q", opts.q);
	// The thread panel's filter — translated server-side into the
	// bank's id-substring filter.
	if (opts.conversation !== undefined) params.set("conversation", opts.conversation);
	if (opts.limit !== undefined) params.set("limit", String(opts.limit));
	if (opts.offset !== undefined) params.set("offset", String(opts.offset));
	const q = params.toString();
	return request(token, `/api/app/memory/documents${q === "" ? "" : `?${q}`}`);
}

export function listThreadSkills(
	token: string | null,
	conversation: string,
): Promise<ThreadSkillsResponse> {
	return request(token, `/api/app/skills/from?conversation=${encodeURIComponent(conversation)}`);
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

export function updateProgram(
	token: string | null,
	id: number,
	patch: {
		name?: string;
		charter?: string;
		cron?: string | null;
		maxLatenessMinutes?: number | null;
		mailFilter?: string | null;
	},
): Promise<AppProgramMutationResponse> {
	return request(token, `/api/app/programs/${id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
}

export function toggleProgram(
	token: string | null,
	id: number,
): Promise<AppProgramMutationResponse> {
	return request(token, `/api/app/programs/${id}/toggle`, { method: "POST" });
}

export function deleteProgram(
	token: string | null,
	id: number,
): Promise<AppProgramMutationResponse> {
	return request(token, `/api/app/programs/${id}`, { method: "DELETE" });
}

export function programHook(
	token: string | null,
	id: number,
	op: "enable" | "rotate" | "disable",
): Promise<AppProgramMutationResponse> {
	return request(token, `/api/app/programs/${id}/hook`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ op }),
	});
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

// The same mechanical decision the Telegram ✅/🚫 row runs.
export function decideSkill(
	token: string | null,
	name: string,
	action: "install" | "discard",
): Promise<SkillDecideResponse> {
	return request(token, "/api/app/skills/decide", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, action } satisfies SkillDecideBody),
	});
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

export function listResponsibilities(token: string | null): Promise<AppResponsibilityFeed> {
	return request(token, "/api/app/responsibilities");
}

export function listProjectResponsibilities(
	token: string | null,
	projectId: string,
): Promise<AppResponsibilityFeed> {
	return request(token, `/api/app/projects/${encodeURIComponent(projectId)}/responsibilities`);
}

export function correctResponsibility(
	token: string | null,
	id: string,
	body: AppCorrectRequest,
): Promise<{ ok: true }> {
	return request(token, `/api/app/responsibilities/${encodeURIComponent(id)}/correct`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

export function responsibilityAction(
	token: string | null,
	id: string,
	action: "pause" | "resume" | "cancel",
): Promise<{ ok: true }> {
	return request(token, `/api/app/responsibilities/${encodeURIComponent(id)}/${action}`, {
		method: "POST",
	});
}

export function attachmentAction(
	token: string | null,
	responsibilityId: string,
	attachmentId: number,
	action: "detach" | "reattach",
): Promise<{ ok?: true; generation?: number }> {
	return request(
		token,
		`/api/app/responsibilities/${encodeURIComponent(responsibilityId)}/attachments/${attachmentId}/${action}`,
		{ method: "POST" },
	);
}
