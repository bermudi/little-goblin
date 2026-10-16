import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveAppDist } from "./http/app-dist.ts";
import { openStore } from "./conversation.ts";
import { openDelegations } from "./delegations.ts";
import { openOutbox } from "./mail-outbox.ts";
import { openPrograms } from "./programs.ts";
import { openSandboxes } from "./sandboxes.ts";
import { openGuestStore } from "./tg/guest.ts";
import { openTelegramInbox } from "./tg/inbox.ts";
import { openPings } from "./tg/pings.ts";
import {
	checkAppAssets,
	healthReportSchema,
	healthResultSchema,
	runHealth,
	type HealthReport,
} from "./health.ts";
import { waitUntil } from "./testkit.ts";

const roots: string[] = [];
const savedPath = process.env.PATH;
const savedHome = process.env.HOME;
const secret = "SYNTHETIC_SECRET_DO_NOT_EMIT_9c0321";
const servers: { stop(closeActiveConnections?: boolean): void }[] = [];
const restorers: (() => void)[] = [];
afterEach(() => {
	for (const restore of restorers.splice(0)) restore();
	for (const server of servers.splice(0)) server.stop(true);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (savedPath === undefined) delete process.env.PATH;
	else process.env.PATH = savedPath;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "goblin-health-test-"));
	roots.push(root);
	const home = join(root, "home"),
		checkout = join(root, "checkout"),
		bin = join(root, "bin");
	for (const dir of [home, checkout, bin]) mkdirSync(dir);
	process.env.PATH = bin;
	process.env.HOME = root;
	const userHome = spyOn(os, "homedir").mockReturnValue(root);
	restorers.push(() => userHome.mockRestore());
	const config = { providers: { fake: { kind: "codex" } }, model: "fake/model", operators: [1] };
	writeFileSync(join(home, "goblin.json5"), JSON.stringify(config));
	writeFileSync(join(home, "auth.jsonl"), JSON.stringify({ name: "telegram", value: secret }), {
		mode: 0o600,
	});
	const script = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
	};
	script(
		"systemctl",
		`printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nWorkingDirectory=${checkout}\\n'`,
	);
	const options = { home, checkout, phase: "preflight" as const };
	return { root, home, checkout, bin, config, script, options };
}
function finding(report: HealthReport, id: string) {
	const found = report.results.find((r) => r.id === id);
	expect(found).toBeDefined();
	return found!;
}
function assets(checkout: string) {
	mkdirSync(join(checkout, "app/dist/assets"), { recursive: true });
	writeFileSync(
		join(checkout, "app/dist/index.html"),
		'<!doctype html><html><script src="/app/assets/main.js"></script><link rel="stylesheet" href="./assets/main.css"></html>',
	);
	writeFileSync(join(checkout, "app/dist/assets/main.js"), "export {};");
	writeFileSync(join(checkout, "app/dist/assets/main.css"), "body {}");
}
function installLayout(home: string) {
	for (const dir of [
		"state",
		"workspace/skills",
		"workspace/skills-proposed",
		"workspace/attachments",
	])
		mkdirSync(join(home, dir), { recursive: true });
	for (const name of ["SOUL.md", "AGENTS.md"])
		writeFileSync(join(home, "workspace", name), "fixture");
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFile(path: string) {
	await waitUntil(() => existsSync(path), "health fixture file lands", 2_000);
	expect(existsSync(path)).toBe(true);
}
function running(pid: number): boolean {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] !== "Z";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

describe("diagnostic boundary and phases", () => {
	test("preflight skips boot-created layout, DB, unit and unbuilt assets; optional features are explicit", async () => {
		const f = fixture(),
			report = await runHealth(f.options);
		expect(healthReportSchema.safeParse(report).success).toBe(true);
		expect(report.target).toEqual({ home: f.home, checkout: f.checkout });
		for (const id of [
			"sqlite",
			"sqlite.subsystems",
			"service.goblin",
			"service.goblin-herdr",
			"sandbox.engine",
			"app.assets",
			"workspace.workspace",
			"workspace.workspace.USER.md",
			"memory.ready",
		])
			expect(finding(report, id).status).toBe("skip");
		expect(finding(report, "config").status).toBe("pass");
		expect(finding(report, "auth.metadata").status).toBe("pass");
		expect(finding(report, "auth.coverage").status).toBe("warn");
		expect(JSON.stringify(report)).not.toContain(secret);
		expect(existsSync(join(f.home, "state"))).toBe(false);
	});
	test("installed missing prerequisites fail without blocking unrelated checks or scaffolding", async () => {
		const f = fixture();
		const report = await runHealth({ ...f.options, phase: "installed" });
		for (const id of ["sqlite", "app.assets", "workspace.workspace", "workspace.state"])
			expect(finding(report, id).status).toBe("fail");
		expect(finding(report, "service.goblin").status).toBe("pass");
		expect(finding(report, "config").status).toBe("pass");
		expect(finding(report, "memory.ready").status).toBe("skip");
		expect(existsSync(join(f.home, "state"))).toBe(false);
	});
	test("config JSON5/schema and auth failures never retain native messages or sentinels", async () => {
		const f = fixture();
		writeFileSync(join(f.home, "goblin.json5"), `{ model: ${secret} }`);
		writeFileSync(join(f.home, "auth.jsonl"), `{"name":"telegram","value":${secret}}`);
		const report = await runHealth(f.options);
		expect(finding(report, "config").status).toBe("fail");
		expect(finding(report, "auth.metadata").detail).toContain("line:1");
		expect(JSON.stringify(report)).not.toContain(secret);
		writeFileSync(
			join(f.home, "goblin.json5"),
			JSON.stringify({ ...f.config, model: `${secret}/model` }),
		);
		writeFileSync(
			join(f.home, "auth.jsonl"),
			JSON.stringify({ name: secret, value: { nested: secret } }),
		);
		expect(JSON.stringify(await runHealth(f.options))).not.toContain(secret);
	});
	test("auth strict poison scan covers live records, mode and missing effective references; never executes refs", async () => {
		const f = fixture(),
			marker = join(f.root, "executed");
		writeFileSync(
			join(f.home, "auth.jsonl"),
			[
				{ name: "telegram", value: `!touch ${marker}` },
				{ name: "unused", value: secret },
				{ name: "unused", value: `!pass-cli ${secret}` },
			]
				.map((record) => JSON.stringify(record))
				.join("\n"),
		);
		expect(finding(await runHealth(f.options), "auth.metadata").detail).toContain(
			"prohibited-owner-session-command:line:3",
		);
		writeFileSync(
			join(f.home, "auth.jsonl"),
			JSON.stringify({ name: "telegram", value: `!touch ${marker}` }),
		);
		expect(finding(await runHealth(f.options), "auth.coverage").detail).toContain(
			"1 general commands",
		);
		expect(existsSync(marker)).toBe(false);
		chmodSync(join(f.home, "auth.jsonl"), 0o640);
		expect(finding(await runHealth(f.options), "auth.metadata").detail).toContain("insecure-mode");
		chmodSync(join(f.home, "auth.jsonl"), 0o600);
		writeFileSync(join(f.home, "auth.jsonl"), "");
		expect(finding(await runHealth(f.options), "auth.metadata").detail).toContain(
			"1 referenced auth records missing",
		);
	});
	test("the poison lint folds last-wins like the runtime: a clean override un-poisons", async () => {
		const f = fixture();
		// Unshadowed pass-cli record still hard-fails, naming the live line.
		writeFileSync(
			join(f.home, "auth.jsonl"),
			[
				{ name: "telegram", value: secret },
				{ name: "telegram", value: `!pass-cli ${secret}` },
			]
				.map((record) => JSON.stringify(record))
				.join("\n"),
		);
		expect(finding(await runHealth(f.options), "auth.metadata").detail).toContain(
			"prohibited-owner-session-command:line:2",
		);
		// The identical raw line shadowed by a later clean same-name record
		// leaves the live record set clean — the diagnostic must pass it.
		writeFileSync(
			join(f.home, "auth.jsonl"),
			[
				{ name: "telegram", value: `!pass-cli ${secret}` },
				{ name: "telegram", value: secret },
			]
				.map((record) => JSON.stringify(record))
				.join("\n"),
		);
		const report = await runHealth(f.options);
		expect(finding(report, "auth.metadata").status).toBe("pass");
		expect(JSON.stringify(report)).not.toContain("prohibited-owner-session-command");
		expect(JSON.stringify(report)).not.toContain(secret);
	});
	test("nonregular and oversized config files are bounded; ENOTDIR is not missing", async () => {
		const f = fixture();
		writeFileSync(join(f.home, "goblin.json5"), "x".repeat(256 * 1024 + 1));
		expect(finding(await runHealth(f.options), "config").detail).toContain("oversized-file");
		rmSync(join(f.home, "goblin.json5"));
		mkdirSync(join(f.home, "goblin.json5"));
		expect(finding(await runHealth(f.options), "config").detail).toContain("not-regular-file");
		writeFileSync(join(f.home, "workspace"), "not a directory");
		expect(finding(await runHealth(f.options), "workspace.workspace.SOUL.md").detail).toContain(
			"ENOTDIR",
		);
	});
});

describe("safe manual next steps", () => {
	test("failures and warnings have static hints, while passes and skips do not", async () => {
		const f = fixture();
		f.script("systemctl", "exit 1");
		const report = await runHealth({ ...f.options, phase: "installed" });
		for (const item of report.results) {
			if (item.status === "fail" || item.status === "warn") expect(item.next).toBeString();
			else expect(item.next).toBeUndefined();
		}
		expect(finding(report, "service.goblin").next).toContain("do not restart");
		expect(finding(report, "sqlite").next).toContain("do not checkpoint");
		expect(finding(report, "auth.coverage").next).toContain("without printing values");
		expect(JSON.stringify(report)).not.toContain(secret);
	});
});

describe("assets and installed checkout", () => {
	test("post-build helper verifies references, encoded escape and symlink escape; I/O differs from absence", () => {
		const f = fixture();
		expect(checkAppAssets(f.checkout).detail).toContain("ENOENT");
		assets(f.checkout);
		expect(healthResultSchema.safeParse(checkAppAssets(f.checkout)).success).toBe(true);
		expect(checkAppAssets(f.checkout).status).toBe("pass");
		writeFileSync(
			join(f.checkout, "app/dist/index.html"),
			'<html><script src="%2e%2e/outside.js"></script>',
		);
		expect(checkAppAssets(f.checkout).detail).toContain("path-escape");
		writeFileSync(join(f.root, "outside.js"), "fixture");
		symlinkSync(join(f.root, "outside.js"), join(f.checkout, "app/dist/leak.js"));
		writeFileSync(join(f.checkout, "app/dist/index.html"), '<html><script src="leak.js"></script>');
		expect(checkAppAssets(f.checkout).detail).toContain("path-escape");
		rmSync(join(f.checkout, "app/dist"), { recursive: true });
		writeFileSync(join(f.checkout, "app/dist"), "wrong type");
		expect(checkAppAssets(f.checkout).detail).toContain("ENOTDIR");
	});
	test("asset checks agree with serving encoded and Unicode browser paths, ignoring navigation links", async () => {
		const f = fixture();
		assets(f.checkout);
		const dist = join(f.checkout, "app/dist");
		writeFileSync(join(dist, "main.js"), "fixture");
		writeFileSync(join(dist, "café.js"), "fixture");
		for (const [ref, expected] of [
			["/app/main%2Ejs", "fail"],
			["/app/café.js", "fail"],
			["/app/main.js?version=1&amp;x=2", "pass"],
			["/app/assets/%2e%2e/main.js", "pass"],
			["/app/%2e%2e/outside.js", "fail"],
			["/app/%2e%2e%2foutside.js", "fail"],
		] as const) {
			writeFileSync(
				join(dist, "index.html"),
				`<html><script src="${ref}"></script><a href="/app/settings">Settings</a><a href="/elsewhere">Elsewhere</a></html>`,
			);
			expect(checkAppAssets(f.checkout).status).toBe(expected);
			const path = new URL(ref, "https://fixture.invalid/app/").pathname;
			const response = path.startsWith("/app/")
				? await serveAppDist(path.slice(5), dist)
				: new Response(null, { status: 404 });
			expect(response.status).toBe(expected === "pass" ? 200 : 404);
		}
		for (const [ref, filename] of [
			["/app/main%2Ejs", "main%2Ejs"],
			["/app/café.js", "caf%C3%A9.js"],
		]) {
			writeFileSync(join(dist, filename!), "fixture");
			writeFileSync(join(dist, "index.html"), `<html><script src="${ref}"></script></html>`);
			expect(checkAppAssets(f.checkout).status).toBe("pass");
			expect(
				(await serveAppDist(new URL(ref!, "https://fixture.invalid").pathname.slice(5), dist))
					.status,
			).toBe(200);
		}
	});
	test("different WorkingDirectory warns and inspects installed assets without redirecting caller home", async () => {
		const f = fixture(),
			installed = join(f.root, "other-checkout");
		mkdirSync(installed);
		assets(installed);
		f.script(
			"systemctl",
			`printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nWorkingDirectory=${installed}\\n'`,
		);
		const report = await runHealth({ ...f.options, phase: "installed" });
		expect(finding(report, "service.goblin").status).toBe("warn");
		expect(finding(report, "app.assets").scope).toContain(installed);
		expect(finding(report, "app.assets").status).toBe("pass");
		expect(report.target.home).toBe(f.home);
		expect(finding(report, "sqlite").scope).toContain(f.home);
	});
});

test("configured mail validates both send credentials locally without resolving them", async () => {
	const f = fixture();
	writeFileSync(
		join(f.home, "goblin.json5"),
		JSON.stringify({
			...f.config,
			mail: {
				clientId: "public-fixture-id",
				clientSecretAuth: "mail-client",
				sendAuth: "mail-send",
			},
		}),
	);
	for (const names of [[], ["mail-client"], ["mail-client", "mail-send"]]) {
		writeFileSync(
			join(f.home, "auth.jsonl"),
			[
				JSON.stringify({ name: "telegram", value: secret }),
				...names.map((name) => JSON.stringify({ name, value: `!printf ${secret}` })),
			].join("\n"),
		);
		const report = await runHealth(f.options);
		expect(finding(report, "auth.metadata").status).toBe(names.length === 2 ? "pass" : "fail");
		expect(JSON.stringify(report)).not.toContain(secret);
	}
});

describe("pass-keys status source contract (fixtures, not a live wallet)", () => {
	for (const [state, output, code, expected] of [
		["ready", "fixture: READY  age=12h0m0s  keys=1  names=BOT_TOKEN", 0, "pass"],
		[
			"digit-leading vault key",
			"fixture: READY  age=0s  keys=2  names=1PASSWORD BOT_TOKEN",
			0,
			"pass",
		],
		[
			"underscore and digit keys",
			"fixture: READY  age=0s  keys=4  names=1 BOT_TOKEN _ _2",
			0,
			"pass",
		],
		["clock skew", "fixture: READY  age=-1h2m3s  keys=1  names=BOT_TOKEN", 0, "warn"],
		["stale", "fixture: READY  age=25h0m0s  keys=1  names=BOT_TOKEN", 0, "warn"],
		["missing key", "fixture: READY  age=2s  keys=1  names=OTHER", 0, "fail"],
		["locked", `fixture: LOCKED  age=none  keys=0\n  ! ${secret}`, 1, "fail"],
		["missing", `fixture: MISSING  age=none  keys=0\n  ! ${secret}`, 1, "fail"],
		["broken", `fixture: BROKEN  age=none  keys=0\n  ! ${secret}`, 1, "fail"],
		["wrong contract", secret, 0, "fail"],
	] as const)
		test(state, async () => {
			const f = fixture(),
				calls = join(f.root, "argv");
			writeFileSync(
				join(f.home, "auth.jsonl"),
				JSON.stringify({ name: "telegram", value: "!pass-keys get fixture BOT_TOKEN" }),
			);
			f.script(
				"pass-keys",
				`printf '%s\\n' "$*" > '${calls}'; printf '%s\\n' '${output}'; exit ${code}`,
			);
			const report = await runHealth(f.options);
			expect(finding(report, "keys.snapshot.1").status).toBe(expected);
			if (state !== "wrong contract")
				expect(finding(report, "keys.snapshot.1").scope).toContain("profile:fixture");
			if (expected !== "pass")
				expect(finding(report, "keys.snapshot.1").next).toContain("operator-owned");
			if (state === "clock skew")
				expect(finding(report, "keys.snapshot.1").detail).toContain("clock skew");
			expect(readFileSync(calls, "utf8")).toBe("status fixture\n");
			expect(JSON.stringify(report)).not.toContain(secret);
		});
	test("a required digit-leading vault key is inspected, not treated as an arbitrary command", async () => {
		const f = fixture();
		writeFileSync(
			join(f.home, "auth.jsonl"),
			JSON.stringify({ name: "telegram", value: "!pass-keys get fixture 1PASSWORD" }),
		);
		f.script("pass-keys", "printf 'fixture: READY  age=1s  keys=1  names=1PASSWORD\\n'");
		expect(finding(await runHealth(f.options), "keys.snapshot.1").status).toBe("pass");
	});
	test("unverified command selectors are not echoed from auth values", async () => {
		const f = fixture();
		const marker = "synthetic_secret_selector";
		writeFileSync(
			join(f.home, "auth.jsonl"),
			JSON.stringify({ name: "telegram", value: `!pass-keys get ${marker} BOT_TOKEN` }),
		);
		f.script("pass-keys", `printf '${marker}\\n' >&2; exit 1`);
		const report = await runHealth(f.options);
		expect(finding(report, "keys.snapshot.1").status).toBe("fail");
		expect(JSON.stringify(report)).not.toContain(marker);
	});
	test.each([
		"!GOBLIN_PROBE=/missing/pass-keys get fixture BOT_TOKEN",
		"!GOBLIN_PROBE+=/missing/pass-keys get fixture BOT_TOKEN",
		"!#/missing/pass-keys get fixture BOT_TOKEN",
	])("shell non-executables remain unverified without a snapshot probe (%#)", async (value) => {
		const f = fixture();
		const calls = join(f.root, "argv");
		writeFileSync(join(f.home, "auth.jsonl"), JSON.stringify({ name: "telegram", value }));
		f.script(
			"pass-keys",
			`printf '%s\\n' "$*" > '${calls}'; printf 'fixture: READY  age=1s  keys=1  names=BOT_TOKEN\\n'`,
		);
		const report = await runHealth(f.options);
		expect(JSON.stringify(report)).toContain("1 general commands");
		expect(report.results.some((r) => r.id === "keys.snapshot.1")).toBe(false);
		expect(existsSync(calls)).toBe(false);
		expect(JSON.stringify(report)).not.toContain(value);
	});
	test("an absolute-path pass-keys get is recognized; only the canonical status probe runs", async () => {
		const f = fixture(),
			calls = join(f.root, "argv"),
			executed = join(f.root, "executed"),
			absolute = join(f.root, "sbin", "pass-keys");
		mkdirSync(join(f.root, "sbin"));
		// If diagnosis ever executed the record's executable this marker
		// would appear — recognition is parse-only, probing stays
		// `pass-keys status <profile>` on PATH.
		writeFileSync(absolute, `#!/bin/sh\ntouch '${executed}'\n`, { mode: 0o700 });
		writeFileSync(
			join(f.home, "auth.jsonl"),
			JSON.stringify({ name: "telegram", value: `!${absolute} get fixture BOT_TOKEN` }),
		);
		f.script(
			"pass-keys",
			`printf '%s\\n' "$*" > '${calls}'; printf 'fixture: MISSING  age=none  keys=0\\n'; exit 1`,
		);
		const report = await runHealth(f.options);
		expect(finding(report, "keys.snapshot.1").status).toBe("fail");
		expect(finding(report, "keys.snapshot.1").scope).toContain("profile:fixture");
		expect(readFileSync(calls, "utf8")).toBe("status fixture\n");
		expect(existsSync(executed)).toBe(false);
	});
});

describe("read-only WAL-aware SQL worker", () => {
	test("required base schema and integrity pass with uncheckpointed WAL; DB/WAL hashes unchanged", async () => {
		const f = fixture();
		installLayout(f.home);
		assets(f.checkout);
		const path = join(f.home, "state/goblin.sqlite");
		const store = openStore(path);
		const writer = new Database(path);
		try {
			writer.exec(
				"PRAGMA wal_autocheckpoint=0; CREATE TABLE diagnostic_extra (value TEXT); INSERT INTO diagnostic_extra VALUES ('fixture')",
			);
			const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
			const before = [hash(path), hash(`${path}-wal`)];
			const report = await runHealth({ ...f.options, phase: "installed" });
			expect(finding(report, "sqlite").status).toBe("pass");
			expect([hash(path), hash(`${path}-wal`)]).toEqual(before);
			// Base schema lives in WAL in this fixture too; ignoring WAL cannot pass.
			expect(finding(report, "sqlite").detail).toContain("WAL-aware");
		} finally {
			writer.close();
			store.close();
		}
	});
	// The worker's argv contract, exercised in a real process: a present
	// but malformed or wrongly-shaped expected-table list fails the probe
	// (open-or-query) instead of silently degrading to a skipped check.
	describe("worker argv contract (real worker process)", () => {
		const WORKER = join(import.meta.dir, "health-sqlite.ts");
		const probe = (
			...args: string[]
		): { code: number; report: Record<string, unknown>; raw: string } => {
			const r = Bun.spawnSync([process.execPath, "--no-install", WORKER, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const raw = r.stdout.toString();
			return { code: r.exitCode, report: JSON.parse(raw) as Record<string, unknown>, raw };
		};
		function baseSchema(): { path: string; close(): void } {
			const dir = mkdtempSync(join(tmpdir(), "goblin-health-worker-"));
			roots.push(dir);
			const path = join(dir, "probe.sqlite");
			const store = openStore(path);
			return { path, close: () => store.close() };
		}
		test("a missing expected-list arg runs the probe with no expectations", () => {
			const { path, close } = baseSchema();
			try {
				const { report } = probe(path);
				expect(report).toEqual({
					status: "pass",
					category: "compatible",
					missingExpected: [],
				});
			} finally {
				close();
			}
		});
		test("valid empty and populated lists report missingExpected honestly", () => {
			const { path, close } = baseSchema();
			try {
				expect(probe(path, "[]").report).toEqual({
					status: "pass",
					category: "compatible",
					missingExpected: [],
				});
				// openStore's schema covers notes but not the later
				// subsystem tables — the split is reported by name.
				expect(probe(path, '["programs","notes","mail_outbox"]').report).toEqual({
					status: "pass",
					category: "compatible",
					missingExpected: ["programs", "mail_outbox"],
				});
			} finally {
				close();
			}
		});
		for (const arg of [
			"{not json",
			'{"tables":["programs"]}',
			'["programs","BAD TABLE"]',
			'["ok",5]',
			'"programs"',
		])
			test(`invalid arg ${JSON.stringify(arg)} fails open-or-query, never a false pass`, () => {
				const { path, close } = baseSchema();
				try {
					expect(probe(path, arg).report).toEqual({
						status: "fail",
						category: "open-or-query",
					});
				} finally {
					close();
				}
			});
	});
	test("structure mismatch is diagnostic compatibility, not installed corruption; extra schema is permitted", async () => {
		const f = fixture();
		installLayout(f.home);
		const path = join(f.home, "state/goblin.sqlite");
		const db = new Database(path);
		db.exec("CREATE TABLE unrelated (id TEXT)");
		db.close();
		const report = await runHealth({ ...f.options, phase: "installed" });
		expect(finding(report, "sqlite").status).toBe("fail");
		expect(finding(report, "sqlite").detail).toContain("structure");
		expect(finding(report, "sqlite").detail).toContain(
			"not a claim of installed-schema corruption",
		);
		writeFileSync(path, secret);
		const corrupt = await runHealth({ ...f.options, phase: "installed" });
		expect(finding(corrupt, "sqlite").status).toBe("fail");
		expect(JSON.stringify(corrupt)).not.toContain(secret);
	});
});

describe("delegation host, subsystem tables and configured sandbox", () => {
	// openStore plus the unconditional open* calls = the boot table set.
	function bootSchema(path: string): { close(): void } {
		const store = openStore(path);
		const extras = [openPrograms(path), openOutbox(path), openSandboxes(path)];
		openPings(store.db);
		openTelegramInbox(store.db);
		openGuestStore(store.db);
		return {
			close() {
				for (const extra of extras) extra.close();
				store.close();
			},
		};
	}
	test("a dead delegation host warns unconfigured and fails once delegation is configured", async () => {
		const f = fixture();
		f.script(
			"systemctl",
			`if [ "$3" = "goblin-herdr.service" ]; then printf 'LoadState=loaded\\nActiveState=failed\\nSubState=failed\\n';
			else printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nWorkingDirectory=${f.checkout}\\n'; fi`,
		);
		const plain = await runHealth({ ...f.options, phase: "installed" });
		expect(finding(plain, "service.goblin").status).toBe("pass");
		expect(finding(plain, "service.goblin-herdr").status).toBe("warn");
		expect(finding(plain, "service.goblin-herdr").detail).toContain("no delegation block");
		writeFileSync(
			join(f.home, "goblin.json5"),
			JSON.stringify({
				...f.config,
				delegation: { harnesses: { devin: { kind: "devin" } } },
			}),
		);
		const delegated = await runHealth({ ...f.options, phase: "installed" });
		expect(finding(delegated, "service.goblin-herdr").status).toBe("fail");
		expect(JSON.stringify(delegated)).not.toContain(secret);
	});
	test("missing boot-created subsystem tables warn by name; a full boot schema passes", async () => {
		const f = fixture();
		installLayout(f.home);
		assets(f.checkout);
		const path = join(f.home, "state/goblin.sqlite");
		// openStore alone = a pre-revision store: base schema compatible,
		// but the later subsystem tables are absent.
		const partial = openStore(path);
		const report = await runHealth({ ...f.options, phase: "installed" });
		const subsystems = finding(report, "sqlite.subsystems");
		expect(subsystems.status).toBe("warn");
		for (const table of ["programs", "mail_outbox", "sandboxes", "tg_inbox", "guest_dedup"])
			expect(subsystems.detail).toContain(table);
		// Wording is revision-scoped expectation drift, never a
		// corruption or store-loss claim without evidence.
		expect(subsystems.detail).toContain("diagnostic revision");
		expect(subsystems.detail).toContain("not evidence of corruption or store loss");
		expect(subsystems.detail).not.toContain("a lost store");
		// Lazy tables are absent from the expectation entirely.
		expect(subsystems.detail).not.toContain("forget_listings");
		expect(subsystems.detail).not.toContain("tg_dm_navigation");
		// Config-gated tables join the expectation with their config block.
		writeFileSync(
			join(f.home, "goblin.json5"),
			JSON.stringify({ ...f.config, delegation: { harnesses: { devin: { kind: "devin" } } } }),
		);
		const gated = finding(
			await runHealth({ ...f.options, phase: "installed" }),
			"sqlite.subsystems",
		);
		expect(gated.detail).toContain("delegations");
		partial.close();
		const complete = bootSchema(path);
		const delegations = openDelegations(path);
		try {
			const full = await runHealth({ ...f.options, phase: "installed" });
			expect(finding(full, "sqlite.subsystems").status).toBe("pass");
		} finally {
			delegations.close();
			complete.close();
		}
	});
	test("sandbox probes stay skip until configured; engine and image readiness split", async () => {
		const f = fixture();
		expect(finding(await runHealth(f.options), "sandbox.engine").status).toBe("skip");
		writeFileSync(
			join(f.home, "goblin.json5"),
			JSON.stringify({ ...f.config, sandbox: { image: "example/img:1" } }),
		);
		// No podman on PATH: the engine check fails, the image check skips.
		const dead = await runHealth(f.options);
		expect(finding(dead, "sandbox.engine").status).toBe("fail");
		expect(finding(dead, "sandbox.image").status).toBe("skip");
		// Engine answers but the configured image is absent: image fails
		// with the manual-pull hint, never an auto-pull.
		f.script("podman", `case "$1" in info) exit 0 ;; image) exit 1 ;; esac; exit 1`);
		const missing = await runHealth(f.options);
		expect(finding(missing, "sandbox.engine").status).toBe("pass");
		const image = finding(missing, "sandbox.image");
		expect(image.status).toBe("fail");
		expect(image.detail).toContain("example/img:1");
		// Image in the local store: both pass. The engine probe is read-only.
		f.script("podman", "exit 0");
		const ready = await runHealth(f.options);
		expect(finding(ready, "sandbox.image").status).toBe("pass");
		expect(existsSync(join(f.home, "state"))).toBe(false);
	});
});

describe("bounded external boundaries and cancellation", () => {
	test("configured readiness 2xx is separate from auth/bank and remote relay coverage", async () => {
		const f = fixture();
		const paths: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				paths.push(new URL(request.url).pathname);
				return new Response(secret);
			},
		});
		servers.push(server);
		writeFileSync(
			join(f.home, "goblin.json5"),
			JSON.stringify({ ...f.config, memory: { baseUrl: server.url.toString(), bankId: secret } }),
		);
		const report = await runHealth(f.options);
		expect(paths).toEqual(["/health/ready"]);
		expect(finding(report, "memory.ready").status).toBe("pass");
		expect(finding(report, "memory.access").status).toBe("warn");
		expect(finding(report, "memory.local-association").status).toBe("skip");
		expect(JSON.stringify(report)).not.toContain(secret);
	});
	test("HTTP outage, oversized response and stalled body produce safe failures", async () => {
		const f = fixture();
		let mode = "outage";
		const server = Bun.serve({
			port: 0,
			fetch() {
				if (mode === "outage") return new Response(secret, { status: 503 });
				if (mode === "big") return new Response(secret.repeat(10000));
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(secret));
						},
					}),
				);
			},
		});
		servers.push(server);
		writeFileSync(
			join(f.home, "goblin.json5"),
			JSON.stringify({
				...f.config,
				memory: { baseUrl: server.url.toString(), bankId: "fixture" },
			}),
		);
		for (const [next, detail] of [
			["outage", "HTTP:503"],
			["big", "oversized-HTTP-body"],
			["stall", "deadline"],
		]) {
			mode = next!;
			const report = await runHealth(f.options);
			expect(finding(report, "memory.ready").status).toBe("fail");
			expect(finding(report, "memory.ready").detail).toContain(detail!);
			expect(JSON.stringify(report)).not.toContain(secret);
		}
	}, 8000);
	test("signal cancels a stalled HTTP body immediately rather than waiting for deadline", async () => {
		const f = fixture(),
			received = join(f.root, "received");
		const server = Bun.serve({
			port: 0,
			fetch() {
				writeFileSync(received, "yes");
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(secret));
						},
					}),
				);
			},
		});
		servers.push(server);
		writeFileSync(
			join(f.home, "goblin.json5"),
			JSON.stringify({
				...f.config,
				memory: { baseUrl: server.url.toString(), bankId: "fixture" },
			}),
		);
		const signal = new AbortController();
		const pending = runHealth({ ...f.options, signal: signal.signal });
		await waitFile(received);
		await sleep(20);
		const start = performance.now();
		signal.abort();
		const report = await pending;
		expect(performance.now() - start).toBeLessThan(600);
		expect(finding(report, "memory.ready").detail).toContain("cancelled");
	});
	for (const abort of [true, false])
		test(abort
			? "abort kills detached leader and grandchild immediately"
			: "per-command deadline kills process groups", async () => {
			const f = fixture(),
				pids = join(f.root, "pids");
			f.script(
				"systemctl",
				`trap '' TERM\n/bin/sh -c 'trap "" TERM; /bin/sleep 60' &\nprintf '%s %s' "$$" "$!" > '${pids}'\nwait`,
			);
			const signal = new AbortController();
			const pending = runHealth({ ...f.options, phase: "installed", signal: signal.signal });
			await waitFile(pids);
			const ids = readFileSync(pids, "utf8").split(" ").map(Number);
			const start = performance.now();
			if (abort) signal.abort();
			const report = await pending;
			expect(performance.now() - start).toBeLessThan(abort ? 600 : 3000);
			expect(finding(report, "service.goblin").detail).toContain(abort ? "cancelled" : "deadline");
			for (const pid of ids) expect(running(pid)).toBe(false);
		}, 5000);
});

describe("capacity thresholds and local embedding identity (synthetic metadata only)", () => {
	test("space and inode thresholds distinguish warnings, failures and unreported inodes", async () => {
		const f = fixture();
		const fake = {
			type: 1n,
			bsize: 1n,
			frsize: 1n,
			blocks: 100n,
			bfree: 0n,
			bavail: 8n * 1024n ** 3n,
			files: 1000n,
			ffree: 500n,
		};
		const statfs = spyOn(fs, "statfsSync").mockReturnValue(fake);
		restorers.push(() => statfs.mockRestore());
		for (const [bytes, inodes, expected] of [
			[8n * 1024n ** 3n, 500n, "pass"],
			[4n * 1024n ** 3n, 500n, "warn"],
			[1024n ** 3n - 1n, 500n, "fail"],
			[8n * 1024n ** 3n, 99n, "warn"],
			[8n * 1024n ** 3n, 9n, "fail"],
		] as const) {
			fake.bavail = bytes;
			fake.ffree = inodes;
			expect(finding(await runHealth(f.options), "storage.home").status).toBe(expected);
		}
		fake.files = 0n;
		expect(finding(await runHealth(f.options), "storage.home").detail).toContain("unreported");
	});
	for (const mode of [
		"matched",
		"wrong-model",
		"malformed-vector",
		"low-space-mount-exit",
		"low-inodes-mount-malformed",
		"low-space-mount-timeout",
	] as const)
		test(mode, async () => {
			const f = fixture(),
				cfg = join(f.root, ".config/goblin-memory");
			const units = join(f.root, ".config/containers/systemd");
			mkdirSync(cfg, { recursive: true });
			mkdirSync(units, { recursive: true });
			writeFileSync(
				join(units, "goblin-memory-api.container"),
				"ContainerName=goblin-memory-api\nPublishPort=127.0.0.1:8888:8888\nEnvironmentFile=%h/.config/goblin-memory/hindsight.env\n",
			);
			writeFileSync(
				join(cfg, "hindsight.env"),
				`HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai\nHINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL=http://127.0.0.1:11435/v1\nHINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL=${mode === "wrong-model" ? "wrong" : "fixture-model"}\nHINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=${secret}\n`,
			);
			writeFileSync(
				join(cfg, "embed-relay.env"),
				"GOBLIN_EMBED_RELAY_ADDR=127.0.0.1\nGOBLIN_EMBED_MODEL=fixture-model\n",
			);
			writeFileSync(
				join(f.home, "goblin.json5"),
				JSON.stringify({
					...f.config,
					memory: { baseUrl: "http://127.0.0.1:8888", bankId: secret },
				}),
			);
			const metadata = JSON.stringify({
				running: true,
				ports: { "8888/tcp": [{ HostIp: "127.0.0.1", HostPort: "8888" }] },
				mounts: [{ Source: join(cfg, "start.py"), Destination: "/opt/goblin-memory-start.py" }],
			});
			const lowCapacity = mode.startsWith("low-");
			if (lowCapacity) {
				const statfs = spyOn(fs, "statfsSync").mockReturnValue({
					type: 1n,
					bsize: 1n,
					frsize: 1n,
					blocks: 100n,
					bfree: 0n,
					bavail: mode.startsWith("low-space") ? 1n : 8n * 1024n ** 3n,
					files: 1000n,
					ffree: mode.startsWith("low-inodes") ? 0n : 500n,
				});
				restorers.push(() => statfs.mockRestore());
			}
			const mountFailure = mode.endsWith("timeout")
				? "/bin/sleep 60"
				: mode.endsWith("malformed")
					? `printf '${secret}'`
					: `printf '${secret}' >&2; exit 1`;
			f.script(
				"podman",
				`if [ "$4" = goblin-memory-api ]; then printf '%s' '${metadata}';
				elif [ "$1" = volume ] && [ '${lowCapacity}' = true ]; then printf '%s' '${JSON.stringify(join(f.root, secret))}';
				else ${mountFailure}; fi`,
			);
			const calls: { url: string; body: unknown }[] = [];
			const fakeFetch: typeof globalThis.fetch = Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					const url = String(input),
						body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
					calls.push({ url, body });
					return new Response(
						url.endsWith("/health/ready")
							? secret
							: mode === "malformed-vector"
								? secret
								: JSON.stringify({ embeddings: [[1, 2, 3]] }),
					);
				},
				{ preconnect: globalThis.fetch.preconnect },
			);
			const fetch = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
			restorers.push(() => fetch.mockRestore());
			const report = await runHealth(f.options);
			expect(JSON.stringify(report)).not.toContain(secret);
			if (mode === "wrong-model") {
				expect(calls.length).toBe(1);
				expect(finding(report, "memory.local-association").status).toBe("warn");
				expect(finding(report, "memory.embedding").status).toBe("skip");
			} else {
				expect(finding(report, "memory.local-association").detail).toContain(
					"match host-local relay",
				);
				expect(calls.length).toBe(2);
				expect(calls[1]).toEqual({
					url: "http://127.0.0.1:11435/api/embed",
					body: { model: "fixture-model", input: "Goblin diagnostic embedding probe." },
				});
				expect(finding(report, "memory.embedding").status).toBe(
					mode === "malformed-vector" ? "fail" : "pass",
				);
				expect(finding(report, "storage.memory-volume").status).toBe(lowCapacity ? "fail" : "warn");
				if (lowCapacity) {
					expect(finding(report, "storage.memory-volume").next).toContain("manual cleanup");
					expect(finding(report, "storage.memory-volume").detail).toContain("Available");
					expect(finding(report, "storage.memory-volume").detail).toContain(
						"mount identity unverified",
					);
				}
			}
		});
});
