// ChatGPT sign-in over OAuth device-code — the same three POSTs the
// codex CLI runs (codex-rs/login/src/device_code_auth.rs + server.rs):
// request a user code, poll the device-token endpoint until the
// operator approves, then exchange once. The poll runs server-side in
// the background; clients only ever read goblin's status. Tokens land
// in goblin's own file (paths.codexAuth()) — ~/.codex stays the CLI's.
//
// Never logged or surfaced: tokens, user_code, device_auth_id,
// code_verifier, response bodies.

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { type Config, loadConfig, parseConfig, paths, writeConfig } from "../../config.ts";
import { durableWriteFile } from "../../durable.ts";
import type { ChatGptStatus } from "../../http/operator-wire.ts";
import { log } from "../../log.ts";
import { OAUTH_CLIENT_ID, resolveCodexAuthFile, type FetchLike } from "./auth.ts";

const USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const VERIFICATION_URL = "https://auth.openai.com/codex/device";
// Codex gives the pairing up to 15 minutes.
const LOGIN_DEADLINE_MS = 15 * 60 * 1000;
const MIN_POLL_INTERVAL_S = 5;

const usercodeSchema = z.object({
	device_auth_id: z.string().min(1),
	// codex accepts the "usercode" alias too.
	user_code: z.string().min(1).optional(),
	usercode: z.string().min(1).optional(),
	// Codex deserializes this as a string and parses the u64 — both
	// shapes are accepted.
	interval: z.union([z.string(), z.number()]).optional(),
	expires_at: z.union([z.string(), z.number()]).optional(),
});

const deviceTokenSchema = z.object({
	authorization_code: z.string().min(1),
	code_challenge: z.string().optional(),
	code_verifier: z.string().min(1),
});

const tokenResponseSchema = z.object({
	id_token: z.string().min(1),
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
});

// Unverified base64url payload decode — the same claim-reading codex
// does; this is our own credential's metadata, not an authenticity check.
function jwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function nestedString(
	payload: Record<string, unknown> | null,
	claim: string,
	key: string,
): string | null {
	const inner = payload?.[claim];
	if (typeof inner !== "object" || inner === null) return null;
	const v = (inner as Record<string, unknown>)[key];
	return typeof v === "string" ? v : null;
}

const emailOf = (payload: Record<string, unknown> | null): string | null =>
	(typeof payload?.email === "string" ? payload.email : null) ??
	nestedString(payload, "https://api.openai.com/profile", "email");
const planOf = (payload: Record<string, unknown> | null): string | null =>
	nestedString(payload, "https://api.openai.com/auth", "chatgpt_plan_type");
const accountIdOf = (payload: Record<string, unknown> | null): string | null =>
	nestedString(payload, "https://api.openai.com/auth", "chatgpt_account_id");

interface PendingLogin {
	id: number;
	deviceAuthId: string;
	userCode: string;
	expiresAt: string;
	intervalMs: number;
	deadlineMs: number;
}

export interface ChatGptLogin {
	status(): ChatGptStatus;
	start(): Promise<ChatGptStatus>;
	cancel(): ChatGptStatus;
	signOut(): ChatGptStatus;
}

type Stage = "usercode" | "poll" | "exchange" | "write";

// What the effective auth file holds — read defensively: a malformed
// file means signed-out, never a thrown status.
function readTokens(path: string): { accessToken: string; idToken: string | null } | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const tokens = (parsed as { tokens?: unknown }).tokens;
		if (typeof tokens !== "object" || tokens === null) return null;
		const t = tokens as Record<string, unknown>;
		return typeof t.access_token === "string"
			? {
					accessToken: t.access_token,
					idToken: typeof t.id_token === "string" ? t.id_token : null,
				}
			: null;
	} catch {
		return null;
	}
}

export function createChatGptLogin(deps: {
	config: () => Config;
	fetch?: FetchLike;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	onSignedIn?(): void;
}): ChatGptLogin {
	const fetchImpl = deps.fetch ?? fetch;
	const now = deps.now ?? (() => Date.now());
	const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));

	let pending: PendingLogin | null = null;
	let lastError: string | null = null;
	let seq = 0;

	function codexAuthFile(): string | undefined {
		const pinned = Object.values(deps.config().providers).find(
			(p) => p.kind === "codex" && p.authFile !== undefined,
		);
		return pinned?.kind === "codex" ? pinned.authFile : undefined;
	}

	function status(): ChatGptStatus {
		const pinned =
			Object.values(deps.config().providers).find(
				(p) => p.kind === "codex" && p.authFile !== undefined,
			) !== undefined;
		if (pending !== null) {
			if (now() < pending.deadlineMs) {
				return {
					state: "pending",
					source: null,
					email: null,
					plan: null,
					pending: {
						userCode: pending.userCode,
						verificationUrl: VERIFICATION_URL,
						expiresAt: pending.expiresAt,
					},
					error: null,
					pinned,
				};
			}
			pending = null;
			lastError = "the pairing code expired — sign in again";
			log.info("chatgpt login expired");
		}
		const resolved = resolveCodexAuthFile(codexAuthFile());
		const file = readTokens(resolved.path);
		if (file !== null) {
			const payload = file.idToken !== null ? jwtPayload(file.idToken) : null;
			return {
				state: "signed-in",
				source: resolved.source,
				email: emailOf(payload),
				plan: planOf(payload),
				pending: null,
				error: null,
				pinned,
			};
		}
		return {
			state: lastError !== null ? "error" : "signed-out",
			source: existsSync(resolved.path) ? resolved.source : null,
			email: null,
			plan: null,
			pending: null,
			error: lastError,
			pinned,
		};
	}

	function fail(stage: Stage, message: string, httpStatus?: number): ChatGptStatus {
		pending = null;
		lastError = message;
		log.warn("chatgpt login failed", {
			stage,
			...(httpStatus !== undefined ? { status: httpStatus } : {}),
		});
		return status();
	}

	async function pollLoop(id: number): Promise<void> {
		while (pending?.id === id) {
			if (now() >= pending.deadlineMs) {
				pending = null;
				lastError = "the pairing code expired — sign in again";
				log.info("chatgpt login expired");
				return;
			}
			await sleep(pending.intervalMs);
			if (pending?.id !== id) return; // cancelled or superseded
			const p = pending;
			let res: Response;
			try {
				res = await fetchImpl(DEVICE_TOKEN_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						device_auth_id: p.deviceAuthId,
						user_code: p.userCode,
					}),
				});
			} catch {
				fail("poll", "device token poll failed");
				return;
			}
			if (res.status === 403 || res.status === 404) continue; // still pending
			if (!res.ok) {
				fail("poll", `device token poll failed: HTTP ${res.status}`, res.status);
				return;
			}
			let grant: z.infer<typeof deviceTokenSchema>;
			try {
				grant = deviceTokenSchema.parse(await res.json());
			} catch {
				fail("poll", "device token poll answered an unexpected body");
				return;
			}
			// The exact field set is the standard PKCE authorization_code
			// grant, form-encoded — derived from codex's server.rs
			// (TokenEncoding::Form). Posted exactly once: the code is
			// single-use, so a failed exchange is never retried.
			let tokens: Response;
			try {
				tokens = await fetchImpl(OAUTH_TOKEN_URL, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "authorization_code",
						code: grant.authorization_code,
						redirect_uri: "https://auth.openai.com/deviceauth/callback",
						client_id: OAUTH_CLIENT_ID,
						code_verifier: grant.code_verifier,
					}).toString(),
				});
			} catch {
				fail("exchange", "token exchange request failed");
				return;
			}
			if (!tokens.ok) {
				fail("exchange", `token exchange failed: HTTP ${tokens.status}`, tokens.status);
				return;
			}
			let t: z.infer<typeof tokenResponseSchema>;
			try {
				t = tokenResponseSchema.parse(await tokens.json());
			} catch {
				fail("exchange", "token exchange answered an unexpected body");
				return;
			}
			const payload = jwtPayload(t.id_token);
			const accountId = accountIdOf(payload);
			try {
				const file = paths.codexAuth();
				mkdirSync(dirname(file), { recursive: true });
				durableWriteFile(
					file,
					JSON.stringify(
						{
							auth_mode: "chatgpt",
							tokens: {
								id_token: t.id_token,
								access_token: t.access_token,
								refresh_token: t.refresh_token,
								...(accountId !== null ? { account_id: accountId } : {}),
							},
							last_refresh: new Date(now()).toISOString(),
						},
						null,
						2,
					) + "\n",
					0o600,
				);
			} catch {
				fail("write", "the auth file could not be written");
				return;
			}
			pending = null;
			lastError = null;
			const plan = planOf(payload);
			log.info("chatgpt login completed", plan !== null ? { plan } : {});
			deps.onSignedIn?.();
			return;
		}
	}

	return {
		status,
		async start(): Promise<ChatGptStatus> {
			// A live pending login is returned as-is — a second start must
			// not request a second pairing code.
			if (pending !== null && now() < pending.deadlineMs) return status();
			pending = null;
			lastError = null;
			let res: Response;
			try {
				res = await fetchImpl(USERCODE_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ client_id: OAUTH_CLIENT_ID }),
				});
			} catch {
				return fail("usercode", "device login request failed");
			}
			if (res.status === 404) {
				return fail("usercode", "device login is not enabled for this client", 404);
			}
			if (!res.ok) {
				return fail("usercode", `device login request failed: HTTP ${res.status}`, res.status);
			}
			let parsed: z.infer<typeof usercodeSchema>;
			try {
				parsed = usercodeSchema.parse(await res.json());
			} catch {
				return fail("usercode", "device login answered an unexpected body");
			}
			const userCode = parsed.user_code ?? parsed.usercode;
			if (userCode === undefined) {
				return fail("usercode", "device login answered no user code");
			}
			const intervalS = Number(parsed.interval ?? MIN_POLL_INTERVAL_S);
			const intervalMs =
				Math.max(
					MIN_POLL_INTERVAL_S,
					Number.isFinite(intervalS) && intervalS > 0 ? intervalS : MIN_POLL_INTERVAL_S,
				) * 1000;
			const deadlineMs = now() + LOGIN_DEADLINE_MS;
			pending = {
				id: ++seq,
				deviceAuthId: parsed.device_auth_id,
				userCode,
				expiresAt:
					parsed.expires_at !== undefined
						? String(parsed.expires_at)
						: new Date(deadlineMs).toISOString(),
				intervalMs,
				deadlineMs,
			};
			log.info("chatgpt login started");
			const id = pending.id;
			// Backgrounded — the client polls goblin's status, not this loop.
			pollLoop(id).catch((err: unknown) => {
				log.error("chatgpt login poll crashed", err);
				fail("poll", "login polling crashed");
			});
			return status();
		},
		cancel(): ChatGptStatus {
			if (pending !== null) {
				pending = null;
				log.info("chatgpt login cancelled");
			}
			return status();
		},
		signOut(): ChatGptStatus {
			pending = null;
			lastError = null;
			try {
				unlinkSync(paths.codexAuth());
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
			log.info("chatgpt signed out");
			return status();
		},
	};
}

// After a successful sign-in: a config with no codex provider gains
// providers.codex = { kind: "codex" } — the same write pattern as the
// app favorites route.
export function ensureCodexProvider(
	configRef: { current: Config },
	onConfigWritten: () => void,
): void {
	const base = loadConfig() ?? parseConfig(configRef.current);
	if (Object.values(base.providers).some((p) => p.kind === "codex")) return;
	const merged = parseConfig({
		...base,
		providers: { ...base.providers, codex: { kind: "codex" } },
	});
	writeConfig(merged);
	const fresh = loadConfig();
	if (fresh !== null) configRef.current = fresh;
	onConfigWritten();
	log.info("codex provider added");
}
