// The device-code flow against a faked fetch — no network, no module
// mocks. The poll loop is driven by an injected clock and instant
// sleep; writes land under a throwaway GOBLIN_HOME.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Config, parseConfig, paths } from "../../config.ts";
import { useHome } from "../../testkit.ts";
import { codexCredentials, resolveCodexAuthFile, type FetchLike } from "./auth.ts";
import { createChatGptLogin, ensureCodexProvider } from "./login.ts";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: object) => `${b64({ alg: "none" })}.${b64(payload)}.sig`;

const ID_TOKEN = jwt({
	email: "op@example.com",
	"https://api.openai.com/profile": { email: "profile@example.com" },
	"https://api.openai.com/auth": {
		chatgpt_account_id: "acct-1",
		chatgpt_plan_type: "pro",
	},
});

const baseConfig = (over: Record<string, unknown> = {}) =>
	parseConfig({
		providers: { main: { kind: "openrouter" } },
		model: "main/m",
		operators: [],
		telegram: { enabled: false },
		...over,
	});

// A config whose codex provider pins authFile at a path that does not
// exist — resolution is then "custom", so a real ~/.codex/auth.json on
// the host can't leak "signed-in" into failure/cancel assertions.
const pinnedConfig = (home: string) =>
	baseConfig({
		providers: { codex: { kind: "codex", authFile: join(home, "pinned.json") } },
		model: "codex/m",
	});

function rig(opts: {
	respond: (url: string, init?: RequestInit) => Response;
	onSignedIn?(): void;
	config?: () => Config;
}) {
	const home = useHome("goblin-login-");
	// homedir() backs the codex-cli fallback — pin HOME at the throwaway
	// home too (tests that need determinism pin authFile instead).
	process.env.HOME = home;
	let t = 1_000_000;
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		calls.push({ url: String(url), init });
		return opts.respond(String(url), init);
	};
	const cfg = opts.config ?? (() => baseConfig());
	const login = createChatGptLogin({
		config: cfg,
		fetch: fetchImpl,
		now: () => t,
		sleep: (ms) => {
			t += ms;
			return Promise.resolve();
		},
		...(opts.onSignedIn !== undefined ? { onSignedIn: opts.onSignedIn } : {}),
	});
	return { home, calls, login };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

// The poll loop runs on microtasks between fake sleeps — a few real
// ticks let it run to completion.
const flush = () => new Promise((r) => setTimeout(r, 10));

function happyFlow(url: string): Response {
	if (url.endsWith("/deviceauth/usercode")) {
		return json({
			device_auth_id: "dev-1",
			user_code: "ABCD-1234",
			interval: "5",
			expires_at: "2099-01-01T00:00:00Z",
		});
	}
	if (url.endsWith("/deviceauth/token")) {
		return json({
			authorization_code: "code-1",
			code_challenge: "cc",
			code_verifier: "cv",
		});
	}
	if (url.endsWith("/oauth/token")) {
		return json({ id_token: ID_TOKEN, access_token: "at-1", refresh_token: "rt-1" });
	}
	throw new Error(`unexpected ${url}`);
}

const REAL_HOME = process.env.HOME;

describe("chatgpt device login", () => {
	afterEach(() => {
		process.env.HOME = REAL_HOME;
	});
	test("start → pending → poll 403s → exchange once → signed-in file", async () => {
		let polls = 0;
		const { calls, login } = rig({
			respond: (url) => {
				if (url.endsWith("/deviceauth/token")) {
					polls++;
					if (polls < 3) return json({}, 403);
				}
				return happyFlow(url);
			},
		});
		expect(login.status().pending).toBeNull();

		const started = await login.start();
		expect(started.state).toBe("pending");
		expect(started.pending?.userCode).toBe("ABCD-1234");
		expect(started.pending?.verificationUrl).toBe("https://auth.openai.com/codex/device");
		expect(started.pending?.expiresAt).toBe("2099-01-01T00:00:00Z");

		// A second start returns the same pending login — one usercode.
		const again = await login.start();
		expect(again.state).toBe("pending");
		expect(calls.filter((c) => c.url.endsWith("/deviceauth/usercode"))).toHaveLength(1);

		await flush();
		const done = login.status();
		expect(done.state).toBe("signed-in");
		expect(done.source).toBe("goblin");
		expect(done.email).toBe("op@example.com");
		expect(done.plan).toBe("pro");
		expect(polls).toBe(3);

		// The token exchange: form-encoded, exactly the five PKCE fields.
		const exchange = calls.find((c) => c.url.endsWith("/oauth/token"))!;
		expect(exchange.init?.headers).toMatchObject({
			"content-type": "application/x-www-form-urlencoded",
		});
		const form = new URLSearchParams(String(exchange.init?.body));
		expect([...form.keys()].sort()).toEqual([
			"client_id",
			"code",
			"code_verifier",
			"grant_type",
			"redirect_uri",
		]);
		expect(form.get("grant_type")).toBe("authorization_code");
		expect(form.get("code")).toBe("code-1");
		expect(form.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
		expect(form.get("code_verifier")).toBe("cv");

		// The file: mode 0600, parses through codexCredentials unchanged.
		const file = paths.codexAuth();
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const auth = await codexCredentials(file, () => {
			throw new Error("no refresh expected for a fresh token");
		});
		expect(auth.tokens.access_token).toBe("at-1");
		expect(auth.tokens.account_id).toBe("acct-1");

		// Nothing secret leaks through the status wire shape.
		const wire = JSON.stringify(done);
		for (const leak of ["at-1", "rt-1", ID_TOKEN, "dev-1", "cv"]) {
			expect(wire).not.toContain(leak);
		}
	});

	test("a failed exchange is reported once and never retried", async () => {
		let exchanges = 0;
		const home = mkdtempSync(join(tmpdir(), "goblin-login-pin-"));
		const { login } = rig({
			config: () => pinnedConfig(home),
			respond: (url) => {
				if (url.endsWith("/oauth/token")) {
					exchanges++;
					return json({ error: "bad_code" }, 400);
				}
				return happyFlow(url);
			},
		});
		await login.start();
		await flush();
		const s = login.status();
		expect(s.state).toBe("error");
		expect(s.error).toContain("400");
		expect(exchanges).toBe(1);
	});

	test("the 15-minute deadline expires a never-approved pairing", async () => {
		const home = mkdtempSync(join(tmpdir(), "goblin-login-pin-"));
		const { login } = rig({
			config: () => pinnedConfig(home),
			respond: (url) => (url.endsWith("/deviceauth/token") ? json({}, 403) : happyFlow(url)),
		});
		await login.start();
		await flush();
		const s = login.status();
		expect(s.state).toBe("error");
		expect(s.error).toContain("expired");
	});

	test("cancel stops the poll and returns to signed-out", async () => {
		let polls = 0;
		const home = mkdtempSync(join(tmpdir(), "goblin-login-pin-"));
		const { login } = rig({
			config: () => pinnedConfig(home),
			respond: (url) => {
				if (url.endsWith("/deviceauth/token")) {
					polls++;
					return json({}, 403);
				}
				return happyFlow(url);
			},
		});
		await login.start();
		expect(login.status().state).toBe("pending");
		const cancelled = login.cancel();
		expect(cancelled.state).toBe("signed-out");
		const seen = polls;
		await flush();
		expect(polls).toBe(seen);
	});

	test("signOut removes goblin's file only — the CLI's file is adopted", async () => {
		const { home, login } = rig({ respond: happyFlow });
		const file = paths.codexAuth();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ tokens: { access_token: "x" } }), { mode: 0o600 });
		// A codex-cli file under the pinned HOME keeps working — signOut
		// must never touch it, and resolution falls through to it.
		const cliFile = join(home, ".codex", "auth.json");
		mkdirSync(dirname(cliFile), { recursive: true });
		writeFileSync(cliFile, JSON.stringify({ tokens: { access_token: "cli-at" } }));
		expect(login.status().state).toBe("signed-in");
		expect(login.status().source).toBe("goblin");
		const s = login.signOut();
		expect(existsSync(file)).toBe(false);
		expect(readFileSync(cliFile, "utf8")).toContain("cli-at");
		expect(s.state).toBe("signed-in");
		expect(s.source).toBe("codex-cli");
	});

	test("resolveCodexAuthFile: custom > goblin > codex-cli", () => {
		useHome("goblin-login-");
		expect(resolveCodexAuthFile("~/mine.json")).toEqual({
			path: join(process.env.HOME ?? "", "mine.json"),
			source: "custom",
		});
		expect(resolveCodexAuthFile().source).toBe("codex-cli");
		mkdirSync(dirname(paths.codexAuth()), { recursive: true });
		writeFileSync(paths.codexAuth(), "{}", { mode: 0o600 });
		expect(resolveCodexAuthFile().source).toBe("goblin");
		expect(resolveCodexAuthFile("/x/y.json").source).toBe("custom");
	});

	test("a successful sign-in adds providers.codex when none exists", async () => {
		const configRef = { current: baseConfig() };
		let writes = 0;
		const { login } = rig({
			respond: happyFlow,
			onSignedIn: () => ensureCodexProvider(configRef, () => writes++),
		});
		await login.start();
		await flush();
		expect(configRef.current.providers["codex"]).toEqual({ kind: "codex" });
		expect(writes).toBe(1);
		// And once configured, a later sign-in adds nothing.
		ensureCodexProvider(configRef, () => writes++);
		expect(writes).toBe(1);
	});
});
