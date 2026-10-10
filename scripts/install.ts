import {
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	mkdtempSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { boundedRun, spawnProc } from "../src/proc.ts";
import { startupCategory } from "./startup-categories.ts";

const repo = resolve(import.meta.dir, "..");
const home = process.env.HOME;
const target = process.env.GOBLIN_HOME ?? (home ? join(home, "goblin") : "");
const bun = process.argv[2];
const cancellation = new AbortController();
let cancelledBy: NodeJS.Signals | undefined;
const signal = (message: string): void => {
	process.stderr.write(`install: ${message}\n`);
};
class InstallFailure extends Error {}
function fail(category: string): never {
	throw new InstallFailure(category);
}

function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
function safePath(path: string): void {
	if (!isAbsolute(path) || !/^[A-Za-z0-9_./+-]+$/.test(path))
		fail("unsupported-path: use absolute paths without spaces or shell/systemd metacharacters");
}
async function command(argv: string[], label: string, timeoutMs = 30_000): Promise<string> {
	await Bun.sleep(0);
	if (cancellation.signal.aborted) fail(`setup cancelled (${cancelledBy}); no later phases`);
	signal(label);
	let result: Awaited<ReturnType<typeof boundedRun>>;
	let proc: Bun.ReadableSubprocess | undefined;
	const commandAbort = new AbortController();
	let escalation: ReturnType<typeof setTimeout> | undefined;
	let cancellationSignalFailed = false;
	const stop = (): void => {
		// Doctor's controller releases its separate worker group on SIGTERM.
		if (proc) {
			try {
				process.kill(-proc.pid, "SIGTERM");
			} catch (error) {
				cancellationSignalFailed = !(
					error instanceof Error &&
					"code" in error &&
					error.code === "ESRCH"
				);
				commandAbort.abort();
				return;
			}
			escalation = setTimeout(() => commandAbort.abort(), 2000);
		} else commandAbort.abort();
	};
	try {
		proc = spawnProc(argv, repo);
		cancellation.signal.addEventListener("abort", stop, { once: true });
		if (cancellation.signal.aborted) stop();
		result = await boundedRun(proc, {
			timeoutMs,
			maxOutput: 4 * 1024 * 1024,
			abortSignal: commandAbort.signal,
		});
	} catch {
		return fail(`${label}: spawn-failed`);
	} finally {
		cancellation.signal.removeEventListener("abort", stop);
		if (escalation) clearTimeout(escalation);
		// Reclaim descendants even when a leader exits before its deadline with pipes already closed.
		if (proc) {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH")
					fail(`${label}: process-group-cleanup-failed`);
			}
		}
	}
	if (cancellationSignalFailed) fail(`${label}: cancellation-signal-failed`);
	if (cancellation.signal.aborted) fail(`setup cancelled (${cancelledBy}); no later phases`);
	if (result.timedOut || result.truncated || result.exitCode !== 0) {
		if (label === "start and accept current invocation") {
			for (const line of result.stderr.split("\n")) {
				if (!line.startsWith("install: ")) continue;
				const category = startupCategory(line.slice("install: ".length));
				if (category) signal(category);
			}
			signal(
				"partial installation: do not rerun fresh setup; recovery/reinstall requires separate operator approval",
			);
		}
		if (
			label === "configured preflight" ||
			label === "installed checks" ||
			label === "start and accept current invocation"
		) {
			const phase = label === "configured preflight" ? "preflight" : "installed";
			signal(
				`read-only diagnostic: (cd ${repo} && GOBLIN_HOME=${target} PATH=${process.env.PATH} ${bun} --no-install run src/doctor.ts --phase ${phase} --json)`,
			);
		}
		fail(
			`${label}: ${result.timedOut ? "timeout" : result.truncated ? "output-limit" : `exit-${result.exitCode}`}`,
		);
	}
	return result.stdout;
}
function render(template: string, replacements: ReadonlyArray<readonly [string, string]>): string {
	let text = readFileSync(join(repo, "deploy", template), "utf8");
	for (const [from, to] of replacements) text = text.replaceAll(from, to);
	return text;
}
function options(raw: string): { delegation: boolean; keys: boolean; port: number } {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return fail("setup-options: invalid-response");
	}
	// The helper owns Zod config/auth validation; bootstrap remains stdlib-only.
	if (
		typeof value !== "object" ||
		value === null ||
		!("delegation" in value) ||
		typeof value.delegation !== "boolean" ||
		!("keys" in value) ||
		typeof value.keys !== "boolean" ||
		!("port" in value) ||
		typeof value.port !== "number" ||
		!Number.isInteger(value.port) ||
		value.port < 0 ||
		value.port > 65535
	)
		fail("setup-options: invalid-response");
	return { delegation: value.delegation, keys: value.keys, port: value.port };
}

async function install(): Promise<void> {
	if (!home || !bun) fail("HOME and Bun executable required");
	if (!process.env.USER || !/^[A-Za-z0-9_.-]+[$]?$/.test(process.env.USER))
		fail("valid USER required for linger");
	for (const path of [repo, home, target, bun]) safePath(path);
	signal(`fresh setup checkout=${repo} home=${target}`);
	process.chdir(repo);
	process.env.GOBLIN_HOME = target;
	const unitDir = join(home, ".config", "systemd", "user");
	const path = [
		...new Set([
			dirname(bun),
			join(home, "bin"),
			join(home, ".local", "bin"),
			"/usr/local/sbin",
			"/usr/local/bin",
			"/usr/bin",
		]),
	].join(":");
	process.env.PATH = path;
	for (const name of ["systemctl", "systemd-analyze", "loginctl"])
		if (!Bun.which(name)) fail(`${name}: missing-prerequisite`);
	// Refuse before changing live dependencies as well as before unit/client writes.
	for (const name of [
		"goblin.service",
		"goblin-herdr.service",
		"goblin-keys.service",
		"goblin-keys.timer",
	]) {
		if (exists(join(unitDir, name)))
			fail(
				"existing-installed-target: use the approved scripts/deploy.sh update; reinstall requires separate operator action",
			);
	}
	if (exists(join(target, "state", "goblin.sqlite")))
		fail(
			"existing-state: fresh setup refuses existing state; reinstall requires separate operator action",
		);
	const loadState = (
		await command(
			["systemctl", "--user", "show", "goblin.service", "--property=LoadState", "--value"],
			"inspect existing target",
		)
	).trim();
	if (loadState !== "not-found")
		fail("existing-or-unknown-target: use approved deployment, not fresh install");
	for (const file of ["goblin.json5", "auth.jsonl"]) {
		const name = join(target, file);
		let input;
		try {
			input = statSync(name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				fail(`${file}: missing — create the two inputs first (docs/setup.md)`);
			throw error;
		}
		if (!input.isFile()) fail(`${file}: not-a-file`);
	}
	if ((statSync(join(target, "auth.jsonl")).mode & 0o077) !== 0)
		fail("auth.jsonl: insecure-mode; chmod 600 before setup");
	if (!statSync(repo).isDirectory() || !statSync(target).isDirectory())
		fail("layout: not-a-directory");

	await command([bun, "install", "--frozen-lockfile"], "sync frozen dependencies", 300_000);
	await command(
		[bun, "--no-install", "run", "src/doctor.ts", "--phase", "preflight", "--json"],
		"configured preflight",
		60_000,
	);
	const selected = options(
		await command(
			[bun, "--no-install", "run", "scripts/install-options.ts"],
			"inspect setup options",
		),
	);
	const herdr = selected.delegation ? Bun.which("herdr") : null;
	const passKeys = selected.keys ? Bun.which("pass-keys") : null;
	if (selected.delegation && !herdr) fail("herdr: configured-but-missing");
	if (selected.keys && !passKeys) fail("pass-keys: configured-but-missing");
	for (const binary of [herdr, passKeys]) if (binary) safePath(binary);
	await command([bun, "run", "app:build"], "build app assets", 300_000);
	await command(
		[bun, "--no-install", "run", "scripts/check-app-assets.ts", repo],
		"verify built assets",
	);

	const staging = mkdtempSync(join(tmpdir(), "goblin-install-units-"));
	try {
		const common: ReadonlyArray<readonly [string, string]> = [
			["/home/daniel/bin", join(home, "bin")],
			["/home/daniel/.local/bin", join(home, ".local", "bin")],
		];
		const names = ["goblin.service"];
		writeFileSync(
			join(staging, "goblin.service"),
			render("goblin.service", [
				["/home/daniel/build/goblin-v2", repo],
				["/home/daniel/goblin", target],
				["/usr/bin/bun", bun],
				...common,
			]).replace(/^Environment=PATH=.*$/m, `Environment=PATH=${path}`),
			{ mode: 0o644 },
		);
		if (herdr) {
			names.push("goblin-herdr.service");
			writeFileSync(
				join(staging, "goblin-herdr.service"),
				render("goblin-herdr.service", [
					["/home/daniel/.local/bin/herdr", herdr],
					...common,
				]).replace(/^Environment=PATH=.*$/m, `Environment=PATH=${path}`),
				{ mode: 0o644 },
			);
		}
		if (passKeys) {
			names.push("goblin-keys.service", "goblin-keys.timer");
			writeFileSync(
				join(staging, "goblin-keys.service"),
				render("goblin-keys.service", [
					["/home/daniel/.local/bin/pass-keys", passKeys],
					...common,
				]).replace(/^Environment=PATH=.*$/m, `Environment=PATH=${path}`),
				{ mode: 0o644 },
			);
			writeFileSync(
				join(staging, "goblin-keys.timer"),
				readFileSync(join(repo, "deploy", "goblin-keys.timer")),
				{ mode: 0o644 },
			);
		}
		await command(
			["systemd-analyze", "--user", "verify", ...names.map((name) => join(staging, name))],
			"validate units",
		);
		// Recheck after slow downloads/builds; another setup must not be overwritten.
		if (
			(
				await command(
					["systemctl", "--user", "show", "goblin.service", "--property=LoadState", "--value"],
					"recheck fresh target",
				)
			).trim() !== "not-found"
		)
			fail("target-changed: refusing installation");
		for (const name of names)
			if (exists(join(unitDir, name))) fail("target-changed: refusing unit overwrite");
		mkdirSync(unitDir, { recursive: true });
		for (const name of names) {
			const destination = join(unitDir, name);
			const temporary = `${destination}.install-${process.pid}`;
			writeFileSync(temporary, readFileSync(join(staging, name)), { mode: 0o644, flag: "wx" });
			const handle = openSync(temporary, "r");
			try {
				fsyncSync(handle);
			} finally {
				closeSync(handle);
			}
			// An exclusive link refuses a concurrently created unit instead of overwriting it.
			linkSync(temporary, destination);
			unlinkSync(temporary);
			const parent = openSync(unitDir, "r");
			try {
				fsyncSync(parent);
			} finally {
				closeSync(parent);
			}
			signal(`unit installed: ${name}`);
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	await command(["systemctl", "--user", "daemon-reload"], "reload user units");
	await command(
		[
			"loginctl",
			"--no-ask-password",
			"enable-linger",
			process.env.USER ?? fail("USER required for linger"),
		],
		"enable linger",
	);
	if (herdr)
		await command(
			["systemctl", "--user", "enable", "--now", "goblin-herdr.service"],
			"enable delegation host",
		);
	if (passKeys) {
		await command(
			["systemctl", "--user", "enable", "goblin-keys.service"],
			"enable background key sync",
		);
		await command(
			["systemctl", "--user", "enable", "--now", "goblin-keys.timer"],
			"enable key refresh timer",
		);
	}
	// The acceptance subprocess captures the baseline BEFORE issuing the start.
	await command(
		[bun, "--no-install", "run", "scripts/check-startup.ts", String(selected.port)],
		"start and accept current invocation",
		65_000,
	);
	await command(
		[bun, "--no-install", "run", "src/doctor.ts", "--phase", "installed", "--json"],
		"installed checks",
		60_000,
	);
	signal("local startup accepted; message the bot and use /app/ for end-to-end acceptance");
}

if (import.meta.main) {
	for (const name of ["SIGINT", "SIGTERM"] as const) {
		process.on(name, () => {
			if (cancelledBy) return;
			cancelledBy = name;
			signal(`cancellation requested (${name})`);
			cancellation.abort();
		});
	}
	try {
		await install();
	} catch (error) {
		// External stderr, auth/config contents and arbitrary native messages stay private.
		const code = (error as NodeJS.ErrnoException).code;
		signal(
			code
				? `filesystem inspection/action failed (${code})`
				: error instanceof InstallFailure
					? error.message
					: "setup failed: internal inspection error",
		);
		process.exitCode = 1;
	}
}
