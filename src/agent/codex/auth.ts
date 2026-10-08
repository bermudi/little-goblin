// Codex OAuth: the credentials lifecycle for the codex provider kind
// (src/agent/codex/model.ts). Auth is codex CLI's OAuth file (default
// ~/.codex/auth.json), read fresh per call so the CLI's own refreshes
// propagate. Expired access tokens are refreshed against the public OAuth
// endpoint and written back — refresh tokens rotate, so not writing back
// would invalidate the CLI's login.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { durableWriteFile } from "../../durable.ts";
import { log } from "../../log.ts";

const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Codex CLI's public OAuth client id — published in the CLI source.
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
// Refresh a token this far ahead of its JWT exp — clock skew plus the
// duration of one request is comfortably covered.
const EXPIRY_MARGIN_S = 60;

// Injectable for tests — narrower than `typeof fetch`, which in Bun
// carries extra members (preconnect) a fake can't satisfy.
export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

const authFileSchema = z.object({
	tokens: z.object({
		access_token: z.string().min(1),
		refresh_token: z.string().min(1).optional(),
		account_id: z.string().min(1).optional(),
	}),
});

const refreshResponseSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1).optional(),
	id_token: z.string().min(1).optional(),
});

export type CodexAuthFile = z.infer<typeof authFileSchema>;

// Read + parse the codex CLI auth file. ENOENT propagates as a pointed
// "run codex login" — the file is the only credential source.
function readAuthFile(path: string): CodexAuthFile {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`codex auth file not found at ${path} — run \`codex login\` first`);
		}
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${path}: not valid JSON — re-run \`codex login\``);
	}
	const result = authFileSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(`${path}: no usable tokens — re-run \`codex login\``);
	}
	return result.data;
}

// JWT exp claim without verification — it's our own credential's lifetime,
// not an authenticity check. Non-JWT tokens count as unexpired.
function tokenExpiryS(token: string): number | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
			exp?: number;
		};
		return typeof payload.exp === "number" ? payload.exp : null;
	} catch {
		return null;
	}
}

// Refresh tokens are single-use — two callers POSTing the same one
// concurrently loses one to invalid_grant and a false "run codex login".
// Single-flight per auth file; concurrent conversations share it.
const refreshInflight = new Map<string, Promise<CodexAuthFile>>();

function expired(token: string): boolean {
	const exp = tokenExpiryS(token);
	return exp !== null && exp - Date.now() / 1000 <= EXPIRY_MARGIN_S;
}

// Fresh credentials for one request: file → expiry check → refresh.
// Exported for tests; the model calls it per request.
export async function codexCredentials(
	path: string,
	fetchImpl: FetchLike = fetch,
): Promise<CodexAuthFile> {
	const auth = readAuthFile(path);
	if (!expired(auth.tokens.access_token)) return auth;
	let p = refreshInflight.get(path);
	if (!p) {
		// The flight is shared — no caller's abort signal may reach it,
		// or one turn's /stop fails every waiter's refresh.
		p = refreshAuth(path, fetchImpl).finally(() => {
			refreshInflight.delete(path);
		});
		refreshInflight.set(path, p);
	}
	return p;
}

async function refreshAuth(path: string, fetchImpl: FetchLike): Promise<CodexAuthFile> {
	// Re-read inside the flight — a sibling refresh (ours or the CLI's)
	// may already have rotated the pair while this caller queued.
	const auth = readAuthFile(path);
	if (!expired(auth.tokens.access_token)) return auth;
	if (!auth.tokens.refresh_token) {
		throw new Error(`${path}: access token expired and no refresh_token — run \`codex login\``);
	}
	const res = await fetchImpl(OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_id: OAUTH_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: auth.tokens.refresh_token,
		}),
		// Hard deadline only — a wedged auth host must not park every
		// caller sharing this flight past the OS tcp timeout.
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) {
		// A 400 here is often a lost race, not a dead login: the codex CLI
		// (or any sibling) consumed the same single-use refresh token and
		// already wrote a fresh pair. Adopt it instead of demanding a
		// re-login that would fix nothing.
		try {
			const raced = readAuthFile(path);
			if (!expired(raced.tokens.access_token)) {
				log.info("codex refresh lost a race — adopted the sibling's fresh tokens", {
					authFile: path,
				});
				return raced;
			}
		} catch {
			// Unreadable now — the refresh failure below is the honest error.
		}
		throw new Error(
			`codex token refresh failed: HTTP ${res.status} — run \`codex login\` to re-authenticate`,
		);
	}
	const refreshed = refreshResponseSchema.parse(await res.json());
	let existing: Record<string, unknown> = {};
	// The merge read must survive a transient failure or a concurrent
	// non-atomic writer: retry briefly. Still failing → write anyway (the
	// new refresh token is single-use; losing it logs the CLI out), but
	// warn — sibling fields would drop out of the file.
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			break;
		} catch (err) {
			if (attempt === 2) {
				log.warn("codex auth re-read failed — writing tokens without sibling fields", {
					authFile: path,
					error: String(err),
				});
			} else {
				await Bun.sleep(50);
			}
		}
	}
	const tokens = {
		...auth.tokens,
		access_token: refreshed.access_token,
		refresh_token: refreshed.refresh_token ?? auth.tokens.refresh_token,
		...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
	};
	durableWriteFile(
		path,
		JSON.stringify(
			{
				...existing,
				tokens: { ...(existing.tokens as object | undefined), ...tokens },
				last_refresh: new Date().toISOString(),
			},
			null,
			2,
		) + "\n",
		// Live OAuth credentials — match the CLI's file mode on recreate.
		0o600,
	);
	log.info("codex oauth token refreshed", { authFile: path });
	return { tokens };
}

export function defaultCodexAuthFile(): string {
	return join(homedir(), ".codex", "auth.json");
}

// "~/…" means the operator's home — the mini app's own placeholder uses it.
export function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
