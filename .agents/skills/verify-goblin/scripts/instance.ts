#!/usr/bin/env bun
// Throwaway goblin instances for verifying a branch. Each one gets its own
// home, HOME, port and scripted fake model, and never sees the real home,
// the checkout's .env, the systemd service or Telegram.
//
//   bun run try [name]          start one and print its URL
//   bun run try status [name]   read-only: is it worth driving?
//   bun run try down [name]     stop what we started, keep the evidence
//   bun run try list            show every instance from this machine

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const REPO = resolve(import.meta.dir, "../../../..");
const SCRATCH = join(tmpdir(), "goblin-verify");
const EVIDENCE = join(homedir(), ".cache", "goblin-verify", "evidence");
const READY_TIMEOUT_MS = 60_000;

const stateSchema = z.object({
	name: z.string(),
	repo: z.string(),
	commit: z.string(),
	home: z.string(),
	port: z.number().int().positive(),
	url: z.string(),
	goblinPid: z.number().int().positive(),
	fakePid: z.number().int().positive(),
});
type State = z.infer<typeof stateSchema>;

function note(message: string): void {
	process.stderr.write(`[verify-goblin] ${message}\n`);
}

function fail(message: string): never {
	note(`error: ${message}`);
	process.exit(1);
}

function checkName(name: string): string {
	if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) fail(`bad instance name: ${name}`);
	return name;
}

const stateFile = (name: string): string => join(SCRATCH, name, "instance.json");
const evidenceDir = (name: string): string => join(EVIDENCE, name);

function readState(name: string): State | null {
	if (!existsSync(stateFile(name))) return null;
	return stateSchema.parse(JSON.parse(readFileSync(stateFile(name), "utf8")));
}

function run(argv: string[], cwd = REPO): string {
	const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		fail(`${argv.join(" ")} failed: ${result.stderr.toString().slice(0, 2000)}`);
	}
	return result.stdout.toString().trim();
}

function newestMtime(dir: string): number {
	let newest = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "dist" || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		const mtime = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
		if (mtime > newest) newest = mtime;
	}
	return newest;
}

function prepareCheckout(): void {
	if (!existsSync(join(REPO, "node_modules"))) {
		note("installing dependencies");
		run(["bun", "install", "--frozen-lockfile"]);
	}
	const built = join(REPO, "app/dist/index.html");
	if (!existsSync(built) || statSync(built).mtimeMs < newestMtime(join(REPO, "app"))) {
		note("building the app");
		run(["bun", "run", "app:build"]);
	}
}

// Only goblin's own processes count: a recycled pid must never get signalled.
function ownsPid(pid: number, marker: string): boolean {
	try {
		return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(marker);
	} catch {
		return false;
	}
}

function isolatedEnv(home: string, name: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin",
		HOME: join(home, "user-home"),
		GOBLIN_HOME: home,
		GOBLIN_VERIFY_INSTANCE: name,
		TMPDIR: join(home, "tmp"),
	};
}

function seedHome(home: string, fakePort: number): void {
	for (const dir of ["user-home", "tmp", "workspace", "state"]) {
		mkdirSync(join(home, dir), { recursive: true });
	}
	const config = {
		providers: {
			fake: { kind: "openai-compatible", baseUrl: `http://127.0.0.1:${fakePort}/v1`, auth: "fake" },
		},
		model: "fake/verify-model",
		operators: [],
		telegram: { enabled: false },
		tts: "",
		http: { port: 0 },
		logLevel: "info",
	};
	writeFileSync(join(home, "goblin.json5"), `${JSON.stringify(config, null, 2)}\n`);
	writeFileSync(
		join(home, "auth.jsonl"),
		`${JSON.stringify({ name: "fake", value: "not-a-secret" })}\n`,
		{
			mode: 0o600,
		},
	);
}

async function waitFor<T>(what: string, probe: () => Promise<T | null> | T | null): Promise<T> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value !== null) return value;
		await Bun.sleep(200);
	}
	throw new Error(`timed out waiting for ${what}`);
}

function bootedPort(logPath: string): number | null {
	if (!existsSync(logPath)) return null;
	for (const line of readFileSync(logPath, "utf8").split("\n")) {
		if (!line.includes('"goblin up"')) continue;
		const port = z.object({ port: z.number() }).safeParse(JSON.parse(line));
		if (port.success) return port.data.port;
	}
	return null;
}

// Ready means usable: the client is served and the API answers from this home.
async function usable(url: string): Promise<boolean> {
	try {
		const page = await fetch(url);
		const conversations = await fetch(new URL("/api/app/conversations", url));
		return page.ok && conversations.ok;
	} catch {
		return false;
	}
}

function stop(pid: number, marker: string): void {
	if (ownsPid(pid, marker)) process.kill(pid, "SIGTERM");
}

async function up(name: string): Promise<void> {
	const existing = readState(name);
	if (existing !== null) {
		if (ownsPid(existing.goblinPid, `GOBLIN_VERIFY_INSTANCE=${name}`)) {
			note(`${name} is already running`);
			process.stdout.write(`${existing.url}\n`);
			return;
		}
		fail(`${name} has stale state. Run: bun run try down ${name}`);
	}
	prepareCheckout();
	const home = join(SCRATCH, name);
	mkdirSync(home, { recursive: true });
	mkdirSync(evidenceDir(name), { recursive: true });
	const env = isolatedEnv(home, name);
	const marker = `GOBLIN_VERIFY_INSTANCE=${name}`;

	const fakePortFile = join(home, "fake-port");
	mkdirSync(join(home, "tmp"), { recursive: true });
	const fake = Bun.spawn(
		["bun", "--no-env-file", join(import.meta.dir, "fake-model.ts"), fakePortFile],
		{
			cwd: home,
			env,
			stdin: "ignore",
			stdout: Bun.file(join(home, "fake-model.log")),
			stderr: Bun.file(join(home, "fake-model.err")),
		},
	);
	fake.unref();
	const fakePort = await waitFor("fake model", () =>
		existsSync(fakePortFile) ? Number(readFileSync(fakePortFile, "utf8")) : null,
	);

	seedHome(home, fakePort);
	const logPath = join(home, "goblin.stdout");
	const goblin = Bun.spawn(["bun", "--no-env-file", join(REPO, "src/index.ts")], {
		cwd: home,
		env,
		stdin: "ignore",
		stdout: Bun.file(logPath),
		stderr: Bun.file(join(home, "goblin.stderr")),
	});
	goblin.unref();

	try {
		const port = await waitFor("goblin to boot", () => {
			if (goblin.exitCode !== null) throw new Error(`goblin exited with ${goblin.exitCode}`);
			return bootedPort(logPath);
		});
		const url = `http://127.0.0.1:${port}/app/`;
		await waitFor("the app to be usable", async () => ((await usable(url)) ? true : null));
		const state: State = {
			name,
			repo: REPO,
			commit: run(["git", "rev-parse", "HEAD"]),
			home,
			port,
			url,
			goblinPid: goblin.pid,
			fakePid: fake.pid,
		};
		writeFileSync(stateFile(name), `${JSON.stringify(state, null, 2)}\n`);
		note(`stop it with: bun run try down ${name}`);
		note(`evidence goes in: ${evidenceDir(name)}`);
		process.stdout.write(`${url}\n`);
		process.exit(0);
	} catch (error) {
		stop(goblin.pid, marker);
		stop(fake.pid, marker);
		const stderr = readFileSync(join(home, "goblin.stderr"), "utf8").slice(-2000);
		fail(`${String(error)}\nscratch kept at ${home}\n${stderr}`);
	}
}

async function status(name: string): Promise<void> {
	const state = readState(name);
	if (state === null) fail(`no instance named ${name}`);
	const marker = `GOBLIN_VERIFY_INSTANCE=${name}`;
	const checks: [string, boolean][] = [
		["goblin process is ours", ownsPid(state.goblinPid, marker)],
		["fake model process is ours", ownsPid(state.fakePid, marker)],
		["home is not the real home", resolve(state.home) !== join(homedir(), "goblin")],
		[
			"checkout is at the same commit",
			run(["git", "rev-parse", "HEAD"], state.repo) === state.commit,
		],
		["app and API answer", await usable(state.url)],
	];
	for (const [label, ok] of checks) process.stdout.write(`${ok ? "ok  " : "FAIL"} ${label}\n`);
	process.stdout.write(`url: ${state.url}\nhome: ${state.home}\nevidence: ${evidenceDir(name)}\n`);
	process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

function down(name: string): void {
	const home = join(SCRATCH, name);
	if (!existsSync(home)) fail(`no instance named ${name}`);
	const state = readState(name);
	const marker = `GOBLIN_VERIFY_INSTANCE=${name}`;
	if (state !== null) {
		stop(state.goblinPid, marker);
		stop(state.fakePid, marker);
	}
	run(["trash", home], SCRATCH);
	note(`stopped ${name}; evidence kept in ${evidenceDir(name)}`);
}

function list(): void {
	if (!existsSync(SCRATCH)) return;
	for (const name of readdirSync(SCRATCH)) {
		const state = readState(name);
		const live = state !== null && ownsPid(state.goblinPid, `GOBLIN_VERIFY_INSTANCE=${name}`);
		process.stdout.write(
			`${name}\t${live ? "running" : "stopped"}\t${state?.url ?? "-"}\t${state?.repo ?? "-"}\n`,
		);
	}
}

const [first, second] = process.argv.slice(2);
if (first === "status") await status(checkName(second ?? "default"));
else if (first === "down") down(checkName(second ?? "default"));
else if (first === "list") list();
else await up(checkName(first ?? "default"));
