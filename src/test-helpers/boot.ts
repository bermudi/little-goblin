// Child-process boot fixtures: a controllable loopback Telegram API and a
// spawned src/index.ts under an isolated GOBLIN_HOME. Synthetic auth only —
// fixture values are literals, never environment secrets.

import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO = join(dirname(import.meta.dir), "..");
const PRELOAD = join(import.meta.dir, "loopback-preload.ts");

export interface FakeTelegram {
	apiRoot: string;
	/** Bot-API method names the fixture has served, in order. */
	methods: string[];
	/** Parsed request bodies, in order — minimal validated shape, no any. */
	calls: { method: string; body: Record<string, unknown> }[];
	releaseGetMe(): void;
	waitMethod(name: string, timeoutMs?: number, count?: number): Promise<void>;
	stop(): void;
}

export interface FakeTelegramOpts {
	getMe: "ok" | "unauthorized" | "held";
	/** Once getMe passes: "hold" the long poll open, "unauthorized" to kill
	 *  polling (grammy rethrows 401/409), or "ok" for an empty batch. */
	getUpdates: "hold" | "unauthorized" | "ok";
}

export function fakeTelegram(opts: FakeTelegramOpts): FakeTelegram {
	const methods: string[] = [];
	const calls: { method: string; body: Record<string, unknown> }[] = [];
	const getMeGate = Promise.withResolvers<void>();
	const heldGate = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const method = new URL(req.url).pathname.split("/").pop() ?? "";
			methods.push(method);
			let body: Record<string, unknown> = {};
			try {
				const parsed: unknown = await req.json();
				if (typeof parsed === "object" && parsed !== null) {
					body = parsed as Record<string, unknown>;
				}
			} catch {
				// Empty or non-JSON body — method name is the record.
			}
			calls.push({ method, body });
			if (method === "getMe") {
				if (opts.getMe === "held") await getMeGate.promise;
				if (opts.getMe === "unauthorized") {
					return Response.json(
						{ ok: false, error_code: 401, description: "Unauthorized" },
						{ status: 401 },
					);
				}
				return Response.json({
					ok: true,
					result: { id: 4200, is_bot: true, first_name: "Fixture Bot", username: "fixture_bot" },
				});
			}
			if (method === "getUpdates") {
				if (opts.getUpdates === "unauthorized") {
					return Response.json(
						{ ok: false, error_code: 401, description: "Unauthorized" },
						{ status: 401 },
					);
				}
				if (opts.getUpdates === "hold") {
					await heldGate.promise; // hold the long poll open until stopped
				}
				return Response.json({ ok: true, result: [] });
			}
			// setMyCommands/setChatMenuButton and anything else: ack.
			return Response.json({ ok: true, result: true });
		},
	});
	return {
		apiRoot: `http://127.0.0.1:${server.port}`,
		methods,
		calls,
		releaseGetMe: () => getMeGate.resolve(),
		async waitMethod(name, timeoutMs = 15000, count = 1) {
			const deadline = Date.now() + timeoutMs;
			while (methods.filter((m) => m === name).length < count) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${name} x${count}`);
				await Bun.sleep(15);
			}
		},
		stop: () => {
			getMeGate.resolve();
			heldGate.resolve();
			server.stop();
		},
	};
}

export interface BootChild {
	home: string;
	port(): number | null;
	lines(): string[];
	waitLog(fragment: string, timeoutMs?: number): Promise<string>;
	http(path: string, init?: RequestInit): Promise<Response>;
	stop(): Promise<number>;
}

export function bootChild(opts: {
	baseDir: string;
	telegram: { enabled: boolean; apiRoot?: string };
	withTelegramAuth?: boolean;
	/** Runs inside the isolated home before the child spawns — seed
	 *  durable state (programs, outbox) through the real stores. */
	seed?: (home: string) => void;
}): BootChild {
	const home = mkdtempSync(join(opts.baseDir, "home-"));
	const blocked = join(home, "blocked-fetch.log");
	const httpPort = 0;
	const tg = opts.telegram.apiRoot !== undefined ? `,apiRoot:"${opts.telegram.apiRoot}"` : "";
	writeFileSync(
		join(home, "goblin.json5"),
		`{providers:{fixture:{kind:"openai-compatible",baseUrl:"http://127.0.0.1:1/v1",auth:"fixture"}},model:"fixture/test",operators:${opts.telegram.enabled ? "[42]" : "[]"},telegram:{enabled:${opts.telegram.enabled}${tg}},http:{port:${httpPort}},logLevel:"debug"}\n`,
	);
	const authRecords = [`{"name":"fixture","value":"synthetic-fixture-key"}`];
	if (opts.withTelegramAuth !== false && opts.telegram.enabled) {
		authRecords.unshift(`{"name":"telegram","value":"0000:synthetic-fixture-token"}`);
	}
	writeFileSync(join(home, "auth.jsonl"), `${authRecords.join("\n")}\n`, { mode: 0o600 });
	chmodSync(join(home, "auth.jsonl"), 0o600);
	opts.seed?.(home);

	mkdirSync(dirname(blocked), { recursive: true });
	appendFileSync(blocked, "");
	const child = Bun.spawn([process.execPath, "--preload", PRELOAD, join(REPO, "src/index.ts")], {
		cwd: REPO,
		env: {
			...process.env,
			HOME: home,
			GOBLIN_HOME: home,
			GOBLIN_BOOTPROBE_BLOCKED: blocked,
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	const lines: string[] = [];
	let dead = false;
	let stopStarted = false;
	void child.exited.then(() => {
		dead = true;
	});
	const stdoutDone = (async () => {
		const dec = new TextDecoder();
		let buf = "";
		for await (const chunk of child.stdout) {
			buf += dec.decode(chunk, { stream: true });
			const parts = buf.split("\n");
			buf = parts.pop() ?? "";
			for (const l of parts) if (l.length > 0) lines.push(l);
		}
		if (buf.length > 0) lines.push(buf);
	})();
	const stderrChunks: string[] = [];
	const stderrDone = (async () => {
		const dec = new TextDecoder();
		for await (const chunk of child.stderr) stderrChunks.push(dec.decode(chunk));
	})();

	const port = { current: null as number | null };
	const api: BootChild = {
		home,
		port: () => port.current,
		lines: () => [...lines, ...stderrChunks],
		async waitLog(fragment, timeoutMs = 15000) {
			const deadline = Date.now() + timeoutMs;
			// stdout flushes through the pipe reader — poll until the line lands.
			for (;;) {
				const m = lines
					.map((l) => {
						try {
							return JSON.parse(l) as { msg?: string; port?: number };
						} catch {
							return undefined;
						}
					})
					.find((j) => j?.msg === "http listening");
				if (m?.port !== undefined) port.current = m.port;
				const hit = lines.find((l) => l.includes(fragment));
				if (hit !== undefined) return hit;
				if (Date.now() > deadline) {
					throw new Error(
						`timed out waiting for log '${fragment}' — saw:\n${lines.join("\n")}\n${stderrChunks.join("\n")}`,
					);
				}
				if (dead) {
					// Process died — fail with everything we saw.
					throw new Error(
						`child exited while waiting for '${fragment}' — saw:\n${lines.join("\n")}\n${stderrChunks.join("\n")}`,
					);
				}
				await Bun.sleep(25);
			}
		},
		async http(path, init) {
			if (port.current === null)
				throw new Error("http port unknown — waitLog('http listening') first");
			return fetch(`http://127.0.0.1:${port.current}${path}`, init);
		},
		async stop() {
			if (!stopStarted) {
				stopStarted = true;
				child.kill("SIGTERM");
			}
			const code = await child.exited;
			// Drain both readers before returning so log assertions see everything.
			await Promise.allSettled([stdoutDone, stderrDone]);
			return code;
		},
	};
	return api;
}
