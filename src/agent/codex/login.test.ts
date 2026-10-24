// The device-code flow against a faked fetch — no network, no module
// mocks. The poll loop is driven by an injected clock and instant
// sleep; writes land under a throwaway GOBLIN_HOME.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { type Config, loadConfig, parseConfig, paths, writeConfig } from "../../config.ts";
import { deferred, useHome, waitUntil } from "../../testkit.ts";
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
	respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
	onSignedIn?(): void;
	config?: () => Config;
}) {
	const home = useHome("goblin-login-");
	// Bun caches homedir() at process start: changing HOME here cannot
	// isolate the CLI fallback. Pin the default fixture to goblin's file
	// instead; the CLI-adoption test uses a child with a fixture HOME.
	let t = 1_000_000;
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		calls.push({ url: String(url), init });
		return opts.respond(String(url), init);
	};
	const cfg =
		opts.config ??
		(() =>
			baseConfig({
				providers: { codex: { kind: "codex", authFile: paths.codexAuth() } },
				model: "codex/m",
			}));
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

describe("chatgpt device login", () => {
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
		expect(done.source).toBe("custom");
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

	test("concurrent starts share the initial request and its result", async () => {
		const response = deferred<Response>();
		const { calls, login } = rig({ respond: () => response.promise });
		const first = login.start();
		const second = login.start();
		expect(second).toBe(first);
		expect(login.status()).toMatchObject({ state: "pending", pending: null });
		await waitUntil(() => calls.length === 1, "one user-code request");
		response.resolve(happyFlow(calls[0]!.url));
		const [a, b] = await Promise.all([first, second]);
		expect(a).toEqual(b);
		expect(a.pending?.userCode).toBe("ABCD-1234");
		login.cancel();
		await flush();
		expect(calls.filter((c) => c.url.endsWith("/deviceauth/usercode"))).toHaveLength(1);
	});

	for (const failure of ["network", "json", "schema"]) {
		test(`an active initial ${failure} failure is shared, reported, and allows a fresh start`, async () => {
			let usercodes = 0;
			const { login } = rig({
				respond: (url) => {
					if (url.endsWith("/deviceauth/usercode") && ++usercodes === 1) {
						if (failure === "network") throw new Error("fixture network failure");
						return failure === "json" ? new Response("not JSON") : json({});
					}
					return happyFlow(url);
				},
			});
			const first = login.start();
			expect(login.start()).toBe(first);
			const failed = await first;
			expect(failed.state).toBe("error");
			expect(failed.error).toContain(failure === "network" ? "request failed" : "unexpected body");
			expect((await login.start()).state).toBe("pending");
			expect(usercodes).toBe(2);
			login.cancel();
			await flush();
		});
	}

	test("cancellation before the initial request is scheduled prevents the fetch", async () => {
		const { calls, login } = rig({ respond: happyFlow });
		const started = login.start();
		expect(login.cancel().state).toBe("signed-out");
		expect((await started).state).toBe("signed-out");
		expect(calls).toHaveLength(0);
	});

	// Hold either response headers or streamed JSON at every network boundary.
	// The fake deliberately ignores abort so ownership, not fetch cooperation,
	// must prevent late success/error from resurrecting or failing a new login.
	for (const endpoint of ["deviceauth/usercode", "deviceauth/token", "oauth/token"]) {
		for (const boundary of ["fetch", "body"] as const) {
			for (const action of ["cancel", "signOut"] as const) {
				for (const outcome of ["success", "error"] as const) {
					test(`${action} fences late ${outcome} at ${endpoint} ${boundary}`, async () => {
						const response = deferred<Response>();
						const reached = deferred();
						let body: ReadableStreamDefaultController<Uint8Array> | undefined;
						let signal: AbortSignal | null | undefined;
						let heldUrl = "";
						let usercodes = 0;
						let signedIn = 0;
						const { calls, login } = rig({
							onSignedIn: () => signedIn++,
							respond: (url, init) => {
								if (url.endsWith("/deviceauth/usercode") && ++usercodes > 1) {
									return new Promise<Response>(() => {}); // replacement stays starting
								}
								if (!url.endsWith(`/${endpoint}`)) return happyFlow(url);
								heldUrl = url;
								signal = init?.signal;
								reached.resolve();
								if (boundary === "fetch") return response.promise;
								return new Response(
									new ReadableStream<Uint8Array>({
										start(controller) {
											body = controller;
										},
									}),
								);
							},
						});
						const started = login.start();
						await reached.promise;
						expect(signal?.aborted).toBe(false);
						expect(login[action]().state).toBe("signed-out");
						expect(signal?.aborted).toBe(true);
						login.start();
						await waitUntil(() => usercodes === 2, "replacement request");
						if (boundary === "fetch") {
							if (outcome === "error") response.reject(new Error("late network failure"));
							else response.resolve(happyFlow(heldUrl));
						} else if (outcome === "error") {
							body!.error(new Error("late body failure"));
						} else {
							body!.enqueue(new TextEncoder().encode(await happyFlow(heldUrl).text()));
							body!.close();
						}
						await started;
						await flush();
						expect(login.status()).toMatchObject({ state: "pending", pending: null, error: null });
						expect(existsSync(paths.codexAuth())).toBe(false);
						expect(signedIn).toBe(0);
						// No next stage may run after the held boundary lost ownership.
						expect(calls).toHaveLength(
							endpoint === "deviceauth/usercode" ? 2 : endpoint === "deviceauth/token" ? 3 : 4,
						);
						login.cancel();
					});
				}
			}
		}
	}

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

	test("a malformed auth file is an error state; a missing one is signed-out", async () => {
		const home = mkdtempSync(join(tmpdir(), "goblin-login-pin-"));
		const pin = join(home, "pinned.json");
		const { login } = rig({
			config: () => pinnedConfig(home),
			respond: happyFlow,
		});
		expect(login.status().state).toBe("signed-out"); // ENOENT → null
		writeFileSync(pin, "{not json");
		const s = login.status();
		expect(s.state).toBe("error");
		expect(s.error).toContain("unreadable");
		expect(s.source).toBe("custom");
	});

	test("a failed sign-in over usable fallback creds stays signed-in but keeps the error", async () => {
		// The pinned file is a working credential the codex provider can
		// still use — a failed pairing must surface as signed-in+error,
		// never as silent success the client could read as completion.
		const home = mkdtempSync(join(tmpdir(), "goblin-login-pin-"));
		writeFileSync(
			join(home, "pinned.json"),
			JSON.stringify({ tokens: { access_token: "cli-at", id_token: ID_TOKEN } }),
		);
		const { login } = rig({
			config: () => pinnedConfig(home),
			respond: (url) =>
				url.endsWith("/deviceauth/usercode") ? json({ error: "down" }, 500) : happyFlow(url),
		});
		const failed = await login.start();
		expect(failed).toMatchObject({
			state: "signed-in",
			source: "custom",
			email: "op@example.com",
			pinned: true,
		});
		expect(failed.error).toContain("500");
		expect(login.status().error).toBe(failed.error);
	});

	test("cancel aborts an in-flight poll fetch", async () => {
		const home = mkdtempSync(join(tmpdir(), "goblin-login-pin-"));
		let pollSignal: AbortSignal | undefined;
		const { login } = rig({
			config: () => pinnedConfig(home),
			respond: (url, init) => {
				if (url.endsWith("/deviceauth/token")) {
					pollSignal = init?.signal ?? undefined;
					return new Promise<Response>(() => {}); // hangs forever
				}
				return Promise.resolve(happyFlow(url));
			},
		});
		await login.start();
		await flush();
		expect(pollSignal).toBeDefined();
		expect(pollSignal?.aborted).toBe(false);
		login.cancel();
		expect(pollSignal?.aborted).toBe(true);
	});

	test("a throwing onSignedIn keeps the completed sign-in signed-in", async () => {
		const { login } = rig({
			respond: happyFlow,
			onSignedIn: () => {
				throw new Error("provider add blew up");
			},
		});
		await login.start();
		await flush();
		expect(login.status().state).toBe("signed-in");
		expect(login.status().source).toBe("custom");
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

	test("signOut removes goblin's file only — the CLI's file is adopted", () => {
		const home = useHome("goblin-login-");
		const file = paths.codexAuth();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ tokens: { access_token: "x" } }), { mode: 0o600 });
		const cliFile = join(home, ".codex", "auth.json");
		mkdirSync(dirname(cliFile), { recursive: true });
		writeFileSync(cliFile, JSON.stringify({ tokens: { access_token: "cli-at" } }));
		const resultFile = join(home, "status.json");
		// Set HOME before Bun starts: no read or write can reach live CLI auth.
		const child = spawnSync(
			process.execPath,
			[
				"--eval",
				`
			import { writeFileSync } from "node:fs";
			import { parseConfig } from "./src/config.ts";
			import { createChatGptLogin } from "./src/agent/codex/login.ts";
			const login = createChatGptLogin({ config: () => parseConfig(${JSON.stringify(baseConfig())}) });
			writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ before: login.status(), after: login.signOut() }));
		`,
			],
			{ env: { ...process.env, HOME: home, GOBLIN_HOME: home }, encoding: "utf8" },
		);
		expect(child.error).toBeUndefined();
		expect(child.status).toBe(0);
		expect(child.stderr).toBe("");
		expect(JSON.parse(readFileSync(resultFile, "utf8"))).toMatchObject({
			before: { state: "signed-in", source: "goblin" },
			after: { state: "signed-in", source: "codex-cli" },
		});
		expect(existsSync(file)).toBe(false);
		expect(readFileSync(cliFile, "utf8")).toContain("cli-at");
	});

	test("resolveCodexAuthFile: custom > goblin > codex-cli", () => {
		useHome("goblin-login-");
		expect(resolveCodexAuthFile("~/mine.json")).toEqual({
			path: join(homedir(), "mine.json"),
			source: "custom",
		});
		expect(resolveCodexAuthFile().source).toBe("codex-cli");
		mkdirSync(dirname(paths.codexAuth()), { recursive: true });
		writeFileSync(paths.codexAuth(), "{}", { mode: 0o600 });
		expect(resolveCodexAuthFile().source).toBe("goblin");
		expect(resolveCodexAuthFile("/x/y.json").source).toBe("custom");
	});

	test("provider creation chooses an unused name without changing existing routes", () => {
		useHome("goblin-login-");
		const base = baseConfig({
			providers: {
				codex: { kind: "openrouter", auth: "existing-key" },
				"codex-2": { kind: "responses", baseUrl: "https://fixture.invalid/v1", auth: "second-key" },
			},
			model: "codex/existing-model",
		});
		writeConfig(base);
		// Disk is authoritative, including names not present in the boot snapshot.
		const configRef = { current: baseConfig() };
		let writes = 0;
		ensureCodexProvider(configRef, () => writes++);
		expect(configRef.current.providers).toEqual({
			...base.providers,
			"codex-3": { kind: "codex" },
		});
		expect(configRef.current.model).toBe(base.model);
		expect(loadConfig()).toEqual(configRef.current);
		ensureCodexProvider(configRef, () => writes++);
		expect(writes).toBe(1);
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
