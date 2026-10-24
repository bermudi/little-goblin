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
import { log } from "../../log.ts";
import { OAUTH_CLIENT_ID, resolveCodexAuthFile, type FetchLike } from "./auth.ts";

export interface ChatGptStatus {
	state: "signed-in" | "signed-out" | "pending" | "error";
	/** Which file supplies the credentials — goblin's own sign-in file,
	 *  the codex CLI's, or a provider-pinned custom path. */
	source: "goblin" | "codex-cli" | "custom" | null;
	email: string | null;
	plan: string | null;
	pending: {
		userCode: string;
		verificationUrl: string;
		expiresAt: string;
	} | null;
	error: string | null;
	/** A codex provider pins authFile in goblin.json5 — in-app sign-in
	 *  is refused until it's removed. */
	pinned: boolean;
}

const USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const VERIFICATION_URL = "https://auth.openai.com/codex/device";
// Codex gives the pairing up to 15 minutes.
const LOGIN_DEADLINE_MS = 15 * 60 * 1000;
const MIN_POLL_INTERVAL_S = 5;
// Every request in the flow hangs for at most this long.
const FETCH_TIMEOUT_MS = 30_000;

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

interface StartingLogin {
	id: number;
	abort: AbortController;
	result: Promise<ChatGptStatus>;
}

interface PendingLogin {
	id: number;
	deviceAuthId: string;
	userCode: string;
	expiresAt: string;
	intervalMs: number;
	deadlineMs: number;
	abort: AbortController;
}

export interface ChatGptLogin {
	status(): ChatGptStatus;
	start(): Promise<ChatGptStatus>;
	cancel(): ChatGptStatus;
	signOut(): ChatGptStatus;
}

type Stage = "usercode" | "poll" | "exchange" | "write";

const UNREADABLE = "unreadable" as const;

// What the effective auth file holds. ENOENT means no login (null — a
// signed-out answer); a present-but-unreadable file is an error state;
// anything else (EACCES and friends) propagates — fail loud.
function readTokens(
	path: string,
): { accessToken: string; idToken: string | null } | null | typeof UNREADABLE {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return UNREADABLE;
		const tokens = (parsed as { tokens?: unknown }).tokens;
		if (typeof tokens !== "object" || tokens === null) return UNREADABLE;
		const t = tokens as Record<string, unknown>;
		return typeof t.access_token === "string"
			? {
					accessToken: t.access_token,
					idToken: typeof t.id_token === "string" ? t.id_token : null,
				}
			: UNREADABLE;
	} catch {
		return UNREADABLE;
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

	let starting: StartingLogin | null = null;
	let pending: PendingLogin | null = null;
	let lastError: string | null = null;
	let seq = 0;

	function clearPending(): void {
		starting?.abort.abort();
		starting = null;
		pending?.abort.abort();
		pending = null;
	}

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
			clearPending();
			lastError = "the pairing code expired — sign in again";
			log.info("chatgpt login expired");
		}
		if (starting !== null) {
			return {
				state: "pending",
				source: null,
				email: null,
				plan: null,
				pending: null, // the user code has not arrived yet
				error: null,
				pinned,
			};
		}
		const resolved = resolveCodexAuthFile(codexAuthFile());
		const file = readTokens(resolved.path);
		if (file === UNREADABLE) {
			return {
				state: "error",
				source: resolved.source,
				email: null,
				plan: null,
				pending: null,
				error: "the auth file is unreadable — sign in again",
				pinned,
			};
		}
		if (file !== null) {
			const payload = file.idToken !== null ? jwtPayload(file.idToken) : null;
			return {
				state: "signed-in",
				source: resolved.source,
				email: emailOf(payload),
				plan: planOf(payload),
				pending: null,
				// Fallback credentials (CLI file, pinned path) stay usable
				// even when the requested sign-in just failed — the state is
				// honestly signed-in AND the error still surfaces on the card,
				// so a failed pairing can't masquerade as completion.
				error: lastError,
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

	function fail(
		stage: Stage,
		message: string,
		opts: { status?: number; err?: unknown } = {},
	): ChatGptStatus {
		clearPending();
		lastError = message;
		const fields = {
			stage,
			...(opts.status !== undefined ? { status: opts.status } : {}),
		};
		if (opts.err !== undefined) log.warn("chatgpt login failed", opts.err, fields);
		else log.warn("chatgpt login failed", fields);
		return status();
	}

	// Every network/body await checks ownership on both success and failure.
	// Abort alone is insufficient: a response or body may settle after cancel.
	// Only the current flow may report a failure; stale flows cannot clear it.
	async function pollLoop(id: number): Promise<void> {
		while (pending?.id === id) {
			if (now() >= pending.deadlineMs) {
				clearPending();
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
					signal: AbortSignal.any([p.abort.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
				});
			} catch (err) {
				if (pending?.id !== id) return; // cancelled or superseded mid-flight
				fail("poll", "device token poll failed", { err });
				return;
			}
			if (pending?.id !== id) return;
			if (res.status === 403 || res.status === 404) continue; // still pending
			if (!res.ok) {
				fail("poll", `device token poll failed: HTTP ${res.status}`, { status: res.status });
				return;
			}
			let grant: z.infer<typeof deviceTokenSchema>;
			try {
				grant = deviceTokenSchema.parse(await res.json());
			} catch (err) {
				if (pending?.id !== id) return;
				fail("poll", "device token poll answered an unexpected body", { err });
				return;
			}
			if (pending?.id !== id) return;
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
					signal: AbortSignal.any([p.abort.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
				});
			} catch (err) {
				if (pending?.id !== id) return;
				fail("exchange", "token exchange request failed", { err });
				return;
			}
			if (pending?.id !== id) return;
			if (!tokens.ok) {
				fail("exchange", `token exchange failed: HTTP ${tokens.status}`, {
					status: tokens.status,
				});
				return;
			}
			let t: z.infer<typeof tokenResponseSchema>;
			try {
				t = tokenResponseSchema.parse(await tokens.json());
			} catch (err) {
				if (pending?.id !== id) return;
				fail("exchange", "token exchange answered an unexpected body", { err });
				return;
			}
			if (pending?.id !== id) return;
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
			} catch (err) {
				fail("write", "the auth file could not be written", { err });
				return;
			}
			pending = null;
			lastError = null;
			const plan = planOf(payload);
			log.info("chatgpt login completed", plan !== null ? { plan } : {});
			try {
				deps.onSignedIn?.();
			} catch (err) {
				// The sign-in itself succeeded — a provider-add failure is
				// reported but must not turn the status into an error.
				log.error("codex provider add failed after sign-in", err);
			}
			return;
		}
	}

	async function requestCode(id: number, abort: AbortController): Promise<ChatGptStatus> {
		// start() installs ownership before scheduling this request. Cancellation
		// can win even before the first fetch, or while its body is being read.
		if (starting?.id !== id) return status();
		let res: Response;
		try {
			res = await fetchImpl(USERCODE_URL, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ client_id: OAUTH_CLIENT_ID }),
				signal: AbortSignal.any([abort.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
			});
		} catch (err) {
			if (starting?.id !== id) return status(); // cancellation owns the outcome
			return fail("usercode", "device login request failed", { err });
		}
		if (starting?.id !== id) return status();
		if (res.status === 404) {
			return fail("usercode", "device login is not enabled for this client", {
				status: 404,
			});
		}
		if (!res.ok) {
			return fail("usercode", `device login request failed: HTTP ${res.status}`, {
				status: res.status,
			});
		}
		let parsed: z.infer<typeof usercodeSchema>;
		try {
			parsed = usercodeSchema.parse(await res.json());
		} catch (err) {
			if (starting?.id !== id) return status(); // cancellation owns the outcome
			return fail("usercode", "device login answered an unexpected body", { err });
		}
		if (starting?.id !== id) return status();
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
			id,
			deviceAuthId: parsed.device_auth_id,
			userCode,
			expiresAt:
				parsed.expires_at !== undefined
					? String(parsed.expires_at)
					: new Date(deadlineMs).toISOString(),
			intervalMs,
			deadlineMs,
			abort,
		};
		starting = null;
		log.info("chatgpt login started");
		// Backgrounded — the client polls goblin's status, not this loop.
		pollLoop(id).catch((err: unknown) => {
			log.error("chatgpt login poll crashed", err);
			// A detached loop must not fail a later login after cancellation.
			if (pending?.id !== id) return;
			fail("poll", "login polling crashed");
		});
		return status();
	}

	return {
		status,
		start(): Promise<ChatGptStatus> {
			// Own the entire flow, including the initial user-code request. Starts
			// arriving before it resolves share one result and one controller.
			if (starting !== null) return starting.result;
			if (pending !== null && now() < pending.deadlineMs) return Promise.resolve(status());
			clearPending();
			lastError = null;
			const id = ++seq;
			const abort = new AbortController();
			const result = Promise.resolve().then(() => requestCode(id, abort));
			starting = { id, abort, result };
			return result;
		},
		cancel(): ChatGptStatus {
			if (starting !== null || pending !== null) {
				clearPending();
				log.info("chatgpt login cancelled");
			}
			return status();
		},
		signOut(): ChatGptStatus {
			clearPending();
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
// a provider under the first unused codex name — the same write pattern as the
// app favorites route.
export function ensureCodexProvider(
	configRef: { current: Config },
	onConfigWritten: () => void,
): void {
	const base = loadConfig() ?? parseConfig(configRef.current);
	if (Object.values(base.providers).some((p) => p.kind === "codex")) return;
	let name = "codex";
	for (let suffix = 2; Object.hasOwn(base.providers, name); suffix++) name = `codex-${suffix}`;
	const merged = parseConfig({
		...base,
		providers: { ...base.providers, [name]: { kind: "codex" } },
	});
	writeConfig(merged);
	const fresh = loadConfig();
	if (fresh !== null) configRef.current = fresh;
	onConfigWritten();
	log.info("codex provider added", { provider: name });
}
