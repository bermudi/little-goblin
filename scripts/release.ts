// Immutable-release deployment (design/deploy.md, ruling 2026-10-24).
//
// The live service runs from `<root>/live`, a symlink resolved at process
// start. `live` points at one complete, private release directory named by
// the commit it was built from: tracked sources via `git archive`, its own
// dependencies, its own built client. Deploying is build-if-missing → flip
// the symlink (one rename) → restart → verify. Rolling back is the same
// without the build, because the previous release is still sitting there,
// intact and complete.
//
// Why this replaced the in-place deploy: the server is TypeScript run in
// place, so a writable live tree meant the running process could drift from
// HEAD — a crash restart picking up uncommitted edits, half-refreshed
// node_modules after a failed deploy, a deployment marker that describes a
// tree that is not what is running. Each of those needed its own guard
// (dirty-tree refusal, attempt markers, HEAD-moved re-checks, conditional
// dependency and client refresh). A release directory makes drift
// unrepresentable: nothing can edit what is running, and a half-built
// release is never visible because it is assembled under `.staging.` and
// renamed into place only when complete.
//
// What deliberately did NOT change: restarting prod requires the
// operator's OK, and this invocation IS that OK — same rule as the script
// it replaces. It never pushes, fetches, or pulls Git refs, and it never
// deletes a release directory (retention is a manual `trash`; see
// `--status`).
//
// Usage: bun scripts/release.ts [flags]   (`--help` prints the flags)

import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmdirSync,
	statSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { durableWriteFile, fsyncDirectory } from "../src/durable.ts";

// Written last, before the staging rename: its presence is what makes "this
// directory holds a deployable build of this commit" a fact rather than a
// guess about which files happen to exist.
const COMPLETE_MARKER = ".release-complete";
const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEFAULT_ACCEPT_BUDGET_MS = 75_000;
const BUILD_TIMEOUT_MS = 300_000;
const LOCK_WAIT_MS = 15 * 60_000;

class DeployError extends Error {}

function fail(message: string): never {
	throw new DeployError(message);
}

// Diagnostics on stderr, results on stdout: the final `deployed <sha>` (and
// `--status`) stay scriptable, everything else is chatter for the human.
function step(message: string): void {
	process.stderr.write(`deploy: ${message}\n`);
}

export function short(rev: string): string {
	return rev.slice(0, 7);
}

export function isRev(value: string): boolean {
	return sha.test(value);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface Layout {
	/** Where release directories live; `live` is a symlink inside it. */
	root: string;
	/** The symlink the unit's WorkingDirectory resolves through. */
	live: string;
	/** The installed unit — source of truth for WorkingDirectory and bun. */
	unit: string;
	/** Rollout mutual exclusion; `mkdir` is the atomic test-and-set. */
	lock: string;
}

export function layoutFrom(
	env: Record<string, string | undefined>,
	home: string = homedir(),
): Layout {
	const root = env.GOBLIN_RELEASES_ROOT ?? join(home, "goblin-releases");
	return {
		root: resolve(root),
		live: resolve(env.GOBLIN_LIVE_LINK ?? join(root, "live")),
		unit: resolve(env.GOBLIN_UNIT_FILE ?? join(home, ".config", "systemd", "user", "goblin.service")),
		lock: join(resolve(root), ".rollout-lock"),
	};
}

export function releaseDir(layout: Layout, rev: string): string {
	return join(layout.root, rev);
}

/** Assembled out of the way, then renamed — an incomplete release is never
 *  addressable by name, so `--rollback <rev>` can never find a half build. */
export function stagingDir(layout: Layout, rev: string): string {
	return join(layout.root, `.staging.${short(rev)}.${process.pid}.${randomBytes(4).toString("hex")}`);
}

export function isCompleteRelease(dir: string, rev: string): boolean {
	try {
		return readFileSync(join(dir, COMPLETE_MARKER), "utf8").trim() === rev;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export interface LiveState {
	rev: string;
	dir: string;
}

/** The rev `live` points at, or null when nothing is deployed yet. A real
 *  file or directory at that path is a layout mistake, not a deploy. */
export function readLive(layout: Layout): LiveState | null {
	let stat;
	try {
		stat = lstatSync(layout.live);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (!stat.isSymbolicLink()) {
		fail(`${layout.live} is not a symlink — refusing to treat it as a release pointer`);
	}
	const target = readlinkSync(layout.live);
	const dir = isAbsolute(target) ? target : resolve(dirname(layout.live), target);
	const rev = dir.split("/").pop() ?? "";
	// A hand-made or truncated link must not be reported as deployed.
	if (!isRev(rev)) fail(`${layout.live} points at ${dir}, which is not a release directory`);
	return { rev, dir };
}

/** Atomic swap: the replacement link is built beside the old one and
 *  rename(2)d over it, so a reader either sees the whole old target or the
 *  whole new one. The directory fsync makes the swap survive a crash. */
export function flipLive(layout: Layout, dir: string): void {
	const tmp = `${layout.live}.tmp-${process.pid}`;
	// Our own scratch from a killed run; removing it cannot lose state.
	if (existsSync(tmp)) unlinkSync(tmp);
	symlinkSync(dir, tmp);
	try {
		renameSync(tmp, layout.live);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// already gone
		}
		fail(`cannot swap ${layout.live}: ${String(error)}`);
	}
	fsyncDirectory(dirname(layout.live));
}

// ---------------------------------------------------------------------------
// The unit is the source of truth for where the code lives and which bun runs
// it. Deploying must not build with one bun and run with another.
// ---------------------------------------------------------------------------

export interface UnitFacts {
	workingDirectory: string;
	execStart: string[];
	environment: Record<string, string>;
}

function unitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

function one(lines: string[], key: string): string {
	const found = lines.filter((line) => line.startsWith(`${key}=`));
	if (found.length !== 1) {
		fail(`unit must have exactly one ${key}= line (found ${found.length})`);
	}
	return found[0]!.slice(key.length + 1).trim();
}

export function parseUnit(text: string): UnitFacts {
	const lines = unitLines(text);
	const workingDirectory = one(lines, "WorkingDirectory");
	if (!isAbsolute(workingDirectory)) {
		fail(`unit WorkingDirectory is not absolute: ${workingDirectory}`);
	}
	const execStart = one(lines, "ExecStart").split(/\s+/).filter((part) => part !== "");
	const argv0 = execStart[0] ?? "";
	if (!isAbsolute(argv0)) fail(`unit ExecStart does not name an absolute binary: ${execStart.join(" ")}`);
	// systemd's Environment= may repeat and may carry several assignments per
	// line; this unit has no quoting, and a quote here means someone edited it
	// by hand — read the truth rather than guess at shell rules.
	const environment: Record<string, string> = {};
	for (const line of lines) {
		if (!line.startsWith("Environment=")) continue;
		for (const assignment of line.slice("Environment=".length).split(/\s+/)) {
			if (assignment === "") continue;
			const eq = assignment.indexOf("=");
			if (eq <= 0) fail(`unit Environment entry has no '=': ${assignment}`);
			environment[assignment.slice(0, eq)] = assignment.slice(eq + 1);
		}
	}
	return { workingDirectory, execStart, environment };
}

/** Line rewrite, not substitution: the value is this box's truth and must
 *  not stay coupled to a template literal that silently no-ops on rename. */
export function rewriteWorkingDirectory(text: string, value: string): string {
	const lines = unitLines(text);
	one(lines, "WorkingDirectory");
	return lines
		.map((line) => (line.startsWith("WorkingDirectory=") ? `WorkingDirectory=${value}` : line))
		.join("\n");
}

function readUnit(layout: Layout): { text: string; facts: UnitFacts } {
	let stat;
	try {
		stat = lstatSync(layout.unit);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(`unit not found: ${layout.unit}`);
		throw error;
	}
	// Writing through a stitch symlink replaces the link with a regular file
	// and silently forks the config — edit the target instead.
	if (stat.isSymbolicLink()) fail(`${layout.unit} is a symlink — rewrite its target in place, not the link`);
	if (!stat.isFile()) fail(`${layout.unit} is not a regular file`);
	const text = readFileSync(layout.unit, "utf8");
	return { text, facts: parseUnit(text) };
}

/** True when the unit already runs out of the release symlink. Compared by
 *  real path: a release directory named directly is the same tree. */
function unitRunsLive(layout: Layout, facts: UnitFacts): boolean {
	try {
		return realpathSync(facts.workingDirectory) === realpathSync(layout.live);
	} catch {
		// Dangling or missing on either side: not the release layout.
		return false;
	}
}

function assertBunUsable(facts: UnitFacts): string {
	const bun = facts.execStart[0]!;
	let ok = false;
	try {
		ok = statSync(bun).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (!ok) fail(`unit ExecStart names ${bun}, which is not an installed file`);
	return bun;
}

// ---------------------------------------------------------------------------
// Child processes: every external command is named here, so the tests can
// fake them at the PATH boundary and nothing else can reach the box.
// ---------------------------------------------------------------------------

interface RunOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	allowFailure?: boolean;
	/** The caller consumes stdout as data: do not echo it. Stderr still
	 *  reaches the operator — diagnostics are never swallowed. */
	quiet?: boolean;
}

export interface RunResult {
	exitCode: number | null;
	signalCode: string | null;
	stdout: string;
	stderr: string;
}

async function run(argv: string[], label: string, options: RunOptions = {}): Promise<RunResult> {
	// exactOptionalPropertyTypes: never pass an explicitly-undefined key to
	// spawn — omit it instead, so the default behaviour stays the default.
	const spawnOptions = {
		stdin: "ignore" as const,
		stdout: "pipe" as const,
		stderr: "pipe" as const,
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		...(options.env === undefined ? {} : { env: options.env }),
		...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
	};
	const proc = Bun.spawn(argv, spawnOptions);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	// Child chatter is forwarded to stderr — a build that fails must leave the
	// operator with the compiler's own words, not a summary. Probes that read
	// stdout as data opt out instead of double-printing their answer.
	if (stdout !== "" && options.quiet !== true) process.stderr.write(stdout);
	if (stderr !== "") process.stderr.write(stderr);
	const result: RunResult = {
		exitCode: proc.exitCode,
		signalCode: proc.signalCode === null ? null : String(proc.signalCode),
		stdout,
		stderr,
	};
	if (result.exitCode !== 0 && options.allowFailure !== true) {
		const how =
			result.exitCode === null
				? options.timeoutMs === undefined
					? `killed by ${result.signalCode ?? "a signal"}`
					: `timed out after ${options.timeoutMs}ms`
				: `exit ${result.exitCode}`;
		fail(`${label} failed (${how})`);
	}
	return result;
}

async function git(repo: string, argv: string[], label: string): Promise<string> {
	const result = await run(["git", "-C", repo, ...argv], label, { quiet: true });
	return result.stdout.trim();
}

/** Resolve the requested rev to one commit, locally present. Nothing is
 *  fetched: the deployable object set is whatever this clone already has. */
export async function resolveRev(repo: string, requested: string | null): Promise<string> {
	const target = requested ?? "HEAD";
	const resolved = await git(repo, ["rev-parse", "--verify", `${target}^{commit}`], `resolve ${target}`);
	if (!isRev(resolved)) fail(`${target} did not resolve to a commit: ${resolved}`);
	return resolved;
}

// ---------------------------------------------------------------------------
// Build: archive the commit into a private directory, give it its own
// dependencies and client, gate on the typecheck, then make it addressable.
// ---------------------------------------------------------------------------

async function buildRelease(context: Context, rev: string): Promise<string> {
	const target = releaseDir(context.layout, rev);
	if (isCompleteRelease(target, rev)) {
		step(`release ${short(rev)} already built`);
		return target;
	}
	if (existsSync(target)) {
		fail(
			`${target} exists but is not a complete ${short(rev)} release; nothing will overwrite it — inspect it, then trash it and retry`,
		);
	}
	const staging = stagingDir(context.layout, rev);
	mkdirSync(staging, { recursive: true });
	step(`building ${short(rev)} in ${staging}`);
	const tarball = join(context.layout.root, `.archive.${short(rev)}.${process.pid}.tar`);
	try {
		await git(context.repo, ["archive", `--output=${tarball}`, "--format=tar", rev], `archive ${short(rev)}`);
		await run(["tar", "-xf", tarball, "-C", staging], "extract archive");
		// The release's own dependency tree: no sharing with the dev checkout,
		// so a stale or half-installed node_modules there cannot be deployed.
		await run([context.bun, "install", "--frozen-lockfile"], "install dependencies", {
			cwd: staging,
			timeoutMs: BUILD_TIMEOUT_MS,
		});
		// The gate, on the exact code and exact dependencies being deployed.
		step("gate: typecheck");
		await run([context.bun, "run", "typecheck"], "typecheck", {
			cwd: staging,
			timeoutMs: BUILD_TIMEOUT_MS,
		});
		await run([context.bun, "run", "app:build"], "build client", {
			cwd: staging,
			timeoutMs: BUILD_TIMEOUT_MS,
		});
		// vite stages into dist.next so a dev checkout's served tree is never
		// written in place. Inside a private release nothing is being served
		// yet, so promotion is a plain rename; the atomic swap is the whole-tree
		// symlink flip below.
		renameSync(join(staging, "app", "dist.next"), join(staging, "app", "dist"));
		await run([context.bun, "--no-install", "run", "scripts/check-app-assets.ts", staging], "verify client assets", {
			cwd: staging,
			timeoutMs: 60_000,
		});
		durableWriteFile(join(staging, COMPLETE_MARKER), `${rev}\n`, 0o644);
		if (existsSync(target)) fail(`${target} appeared during the build — refusing to replace it`);
		renameSync(staging, target);
		fsyncDirectory(context.layout.root);
	} finally {
		// Script-owned scratch only; a failed build's staging directory is left
		// behind for inspection (the error line names it) because deleting it
		// would also delete the evidence.
		if (existsSync(tarball)) unlinkSync(tarball);
	}
	step(`release ${short(rev)} ready at ${target}`);
	return target;
}

// ---------------------------------------------------------------------------
// Restart, acceptance, annotations
// ---------------------------------------------------------------------------

const identitySchema = z.object({
	invocationId: z.string().regex(/^(?:[a-f0-9]{32})?$/),
	monotonic: z.coerce.number().int().nonnegative(),
});

async function serviceIdentity(): Promise<{ invocationId: string; monotonic: number }> {
	const result = await run(
		["systemctl", "--user", "show", "goblin.service", "--property=InvocationID,ExecMainStartTimestampMonotonic", "--value"],
		"read service identity",
		{ quiet: true },
	);
	const [invocationId = "", monotonic = ""] = result.stdout.trim().split("\n");
	const parsed = identitySchema.safeParse({ invocationId, monotonic });
	if (!parsed.success) fail(`unreadable service identity: ${JSON.stringify(result.stdout.trim())}`);
	return parsed.data;
}

/** goblin.log annotation: a deploy-initiated restart must be distinguishable
 *  from a spontaneous one, or an unexplained "shutting down" reads as an
 *  incident. Lines match src/log.ts's JSONL shape. Diagnostics, not gating. */
function annotate(logPath: string | null, message: string, rev: string, was: string | null): void {
	if (logPath === null) {
		step("WARNING — GOBLIN_HOME unresolved from the unit; goblin.log will not carry deploy context");
		return;
	}
	const record: Record<string, string> = {
		ts: new Date().toISOString(),
		level: "info",
		msg: `deploy ${message}`,
		rev,
	};
	if (was !== null) record.was = was;
	try {
		appendFileSync(logPath, `${JSON.stringify(record)}\n`);
	} catch (error) {
		step(`WARNING — could not append the goblin.log annotation: ${String(error)}`);
	}
}

async function memoryProbe(): Promise<void> {
	if (!Bun.which("podman")) {
		step("memory probe skipped: podman unavailable");
		return;
	}
	const exists = await run(["podman", "container", "exists", "goblin-memory-api"], "inspect memory container", {
		allowFailure: true,
	});
	if (exists.exitCode === 0) {
		const health = await run(
			["podman", "inspect", "goblin-memory-api", "--format", "{{.State.Health.Status}}"],
			"read memory health",
			{ quiet: true },
		);
		const status = health.stdout.trim();
		step(`goblin-memory-api: ${status}`);
		if (status !== "healthy") fail(`memory API is not healthy (${status})`);
		return;
	}
	// Podman's exists contract: 1 means absent; other codes are failures.
	if (exists.exitCode !== 1) fail(`podman container exists failed (exit ${exists.exitCode})`);
	const loadState = await run(
		["systemctl", "--user", "show", "--property=LoadState", "--value", "goblin-memory-api.service"],
		"inspect memory unit",
		{ quiet: true },
	);
	const state = loadState.stdout.trim();
	if (state === "not-found") {
		step("memory stack not installed");
		return;
	}
	fail(`memory API unit is ${state} but its container is absent; inspect systemctl --user status goblin-memory-api`);
}

/** Restart into whatever `live` names now, then require evidence from the
 *  invocation this restart created. A bare is-active poll closes before slow
 *  boot failures (a timed-out provider handshake) surface. */
async function restartAndVerify(context: Context, release: string, rev: string, was: string | null): Promise<void> {
	const floor = await serviceIdentity();
	const logPath = context.goblinHome === null ? null : join(context.goblinHome, "state", "goblin.log");
	annotate(logPath, "restarting goblin", rev, was);
	const startedAt = Math.floor(Date.now() / 1000);
	await run(["systemctl", "--user", "restart", "goblin"], "restart goblin");
	step("verify: startup acceptance");
	await run(
		[
			context.bun,
			join(release, "scripts", "check-startup.ts"),
			"--watch",
			"0",
			String(context.acceptBudgetMs),
			floor.invocationId,
			String(floor.monotonic),
		],
		"startup acceptance",
		{
			cwd: release,
			env: context.goblinHome === null ? process.env : { ...process.env, GOBLIN_HOME: context.goblinHome },
			timeoutMs: context.acceptBudgetMs + 10_000,
		},
	);
	annotate(logPath, "restart accepted — goblin live at deployed rev", rev, null);
	// Reported, never fatal: a rotation race or a grep miss must not fail a
	// rollout that the acceptance probe already passed — but a recurring boot
	// error should ship visibly with the deploy that introduced it.
	const journal = await run(
		["journalctl", "--user", "-u", "goblin", "--since", `@${startedAt}`, "--no-pager"],
		"read the fresh journal",
		{ allowFailure: true, quiet: true },
	);
	if (journal.exitCode !== 0) step("WARNING — could not read the fresh journal; error scan skipped");
	const errors = journal.stdout.split("\n").filter((line) => line.includes('"level":"error"'));
	if (errors.length > 0) {
		step(`WARNING — ${errors.length} error line(s) in the fresh journal:`);
		for (const line of errors.slice(-5)) process.stderr.write(`  ${line}\n`);
	}
	await memoryProbe();
}

// ---------------------------------------------------------------------------
// Mutual exclusion: a rollout that waits must not let a finishing sibling
// flip `live` back underneath it.
// ---------------------------------------------------------------------------

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else — still alive.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function lockHolder(lock: string): number | null {
	try {
		const pid = Number(readFileSync(join(lock, "pid"), "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function acquireLock(layout: Layout): Promise<() => void> {
	// The lock lives inside the releases root, which may not exist on a box's
	// first release.
	mkdirSync(layout.root, { recursive: true });
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			mkdirSync(layout.lock);
			durableWriteFile(join(layout.lock, "pid"), `${process.pid}\n`, 0o644);
			return () => {
				try {
					unlinkSync(join(layout.lock, "pid"));
					rmdirSync(layout.lock);
				} catch {
					// Best effort: a leftover lock is reported, never auto-cleared.
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const holder = lockHolder(layout.lock);
		if (holder !== null && !pidAlive(holder)) {
			fail(`stale rollout lock at ${layout.lock} (pid ${holder} is gone) — trash it if no rollout is running`);
		}
		if (Date.now() > deadline) {
			fail(`rollout lock held for over ${LOCK_WAIT_MS / 60_000}m (${layout.lock}) — inspect the running rollout`);
		}
		step("another rollout is running — waiting");
		await Bun.sleep(500);
	}
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface Context {
	repo: string;
	layout: Layout;
	bun: string;
	goblinHome: string | null;
	acceptBudgetMs: number;
}

async function context(): Promise<Context> {
	const repo = resolve(import.meta.dir, "..");
	if (!existsSync(join(repo, "bun.lock"))) {
		fail(`${repo} is not a checkout with bun.lock — run this from the development tree, not a release`);
	}
	// `.git` is a directory in a clone and a file in a linked worktree; a
	// release built by `git archive` has neither. This is the whole check —
	// spawning git for it would print inside every rollout.
	if (!existsSync(join(repo, ".git"))) {
		fail(`${repo} is not a git checkout — run this from the development tree, not a release`);
	}
	const layout = layoutFrom(process.env);
	const { facts } = readUnit(layout);
	const bun = assertBunUsable(facts);
	// The probe reads config, log and state from the unit's own home: a shell
	// GOBLIN_HOME must never decide which deployment is being verified.
	const goblinHome = facts.environment.GOBLIN_HOME ?? null;
	const budget = Number(process.env.GOBLIN_ACCEPT_BUDGET_MS ?? DEFAULT_ACCEPT_BUDGET_MS);
	return {
		repo,
		layout,
		bun,
		goblinHome,
		acceptBudgetMs: Number.isInteger(budget) && budget > 0 ? budget : DEFAULT_ACCEPT_BUDGET_MS,
	};
}

async function rollout(ctx: Context, rev: string): Promise<void> {
	const { facts } = readUnit(ctx.layout);
	if (!unitRunsLive(ctx.layout, facts)) {
		fail(
			`goblin.service does not run from ${ctx.layout.live} (WorkingDirectory=${facts.workingDirectory}); ` +
				"this box is still in the in-place layout — run --adopt-unit once to cut over",
		);
	}
	const dir = await buildRelease(ctx, rev);
	const live = readLive(ctx.layout);
	step(`flip: ${live === null ? "none" : short(live.rev)} -> ${short(rev)}`);
	flipLive(ctx.layout, dir);
	await restartAndVerify(ctx, dir, rev, live?.rev ?? null);
	process.stdout.write(`deployed ${rev}\n`);
	if (live !== null) process.stdout.write(`rollback: bun scripts/release.ts --rollback ${live.rev}\n`);
}

async function rollback(ctx: Context, rev: string): Promise<void> {
	const { facts } = readUnit(ctx.layout);
	if (!unitRunsLive(ctx.layout, facts)) {
		fail(`goblin.service does not run from ${ctx.layout.live}; rollback only applies to the release layout`);
	}
	const dir = releaseDir(ctx.layout, rev);
	if (!isCompleteRelease(dir, rev)) fail(`no complete release for ${rev} at ${dir}`);
	const live = readLive(ctx.layout);
	step(`flip: ${live === null ? "none" : short(live.rev)} -> ${short(rev)} (rollback)`);
	flipLive(ctx.layout, dir);
	await restartAndVerify(ctx, dir, rev, live?.rev ?? null);
	process.stdout.write(`rolled back to ${rev}\n`);
}

/** One-time cutover from the in-place layout: build, point `live` at it, and
 *  rewrite the single WorkingDirectory line so every later release is a
 *  symlink flip. Only the value changes — a hand-edited unit is reported,
 *  never silently replaced with a rendered copy. */
async function adoptUnit(ctx: Context, rev: string): Promise<void> {
	const { text, facts } = readUnit(ctx.layout);
	if (unitRunsLive(ctx.layout, facts)) {
		step("unit already runs from the release symlink — deploying instead of adopting");
		await rollout(ctx, rev);
		return;
	}
	const dir = await buildRelease(ctx, rev);
	flipLive(ctx.layout, dir);
	const rewritten = rewriteWorkingDirectory(text, ctx.layout.live);
	durableWriteFile(ctx.layout.unit, rewritten, 0o644);
	step(`unit: WorkingDirectory=${facts.workingDirectory} -> ${ctx.layout.live}`);
	await run(["systemctl", "--user", "daemon-reload"], "reload user units");
	await restartAndVerify(ctx, dir, rev, null);
	process.stdout.write(`adopted release layout and deployed ${rev}\n`);
}

async function status(ctx: Context): Promise<void> {
	const live = readLive(ctx.layout);
	const { facts } = readUnit(ctx.layout);
	const lines: string[] = [];
	lines.push(live === null ? "live: none" : `live: ${live.dir} (${short(live.rev)})`);
	lines.push(
		`unit: WorkingDirectory=${facts.workingDirectory} ${unitRunsLive(ctx.layout, facts) ? "(release layout)" : "(MISMATCH — run --adopt-unit)"}`,
	);
	lines.push(`bun: ${facts.execStart[0]}`);
	// The running process's cwd is the release it was started from. When that
	// differs from `live`, a rollout flipped the link but never restarted — the
	// one inconsistency this layout can still hold, so it is shown, not hidden.
	const pidResult = await run(
		["systemctl", "--user", "show", "goblin.service", "--property=MainPID", "--value"],
		"read main pid",
		{ allowFailure: true, quiet: true },
	);
	const pid = Number(pidResult.stdout.trim());
	if (Number.isInteger(pid) && pid > 0) {
		try {
			// /proc resolves the cwd to the real path, so this names the release
			// the process was started from even when the unit went in via `live`.
			const running = readlinkSync(`/proc/${pid}/cwd`);
			const name = running.split("/").pop() ?? "";
			// Before the cutover the running tree is a checkout, not a release:
			// say so rather than calling it "restart pending" forever.
			if (!isRev(name)) {
				lines.push(`running: ${running} (in-place checkout)`);
			} else {
				const matches = live !== null && resolve(running) === resolve(live.dir);
				lines.push(`running: ${short(name)}${matches ? "" : " (restart pending)"}`);
			}
		} catch {
			lines.push("running: unknown");
		}
	}
	const releases = existsSync(ctx.layout.root)
		? readdirSync(ctx.layout.root)
				.filter((name) => isRev(name))
				.map((name) => ({ name, at: statSync(join(ctx.layout.root, name)).mtime }))
				.sort((a, b) => b.at.getTime() - a.at.getTime())
		: [];
	lines.push(`releases: ${releases.length} under ${ctx.layout.root}`);
	for (const release of releases) {
		const liveMark = live !== null && live.rev === release.name ? " *live*" : "";
		lines.push(`  ${short(release.name)}  ${release.at.toISOString()}${liveMark}`);
	}
	lines.push("retention: manual — `trash` old release directories; nothing is pruned automatically");
	process.stdout.write(`${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export type Command =
	| { kind: "rollout"; rev: string | null }
	| { kind: "build"; rev: string | null }
	| { kind: "rollback"; rev: string }
	| { kind: "adopt-unit"; rev: string | null }
	| { kind: "status" }
	| { kind: "help" };

const USAGE = `usage: bun scripts/release.ts [command]

  (none)                 build HEAD if missing, flip live, restart, verify
  --rev <rev>            deploy a specific commit (any rev git can resolve)
  --rollback <rev>       flip back to an existing release and restart
  --build-only           build and gate a release; touch nothing live
  --adopt-unit           ONE TIME: cut this box over to the release layout
  --status               what is live, what is running, what is kept

Restarting prod is the operator's call: running the rollout command is that
call. Nothing is pushed, fetched or pulled; no release is ever deleted.
`;

export function parseArgs(argv: string[]): Command {
	const [first, ...rest] = argv;
	switch (first) {
		case undefined:
			return { kind: "rollout", rev: null };
		case "--help":
		case "-h":
			return { kind: "help" };
		case "--status":
			return { kind: "status" };
		case "--build-only":
			return { kind: "build", rev: rest[0] ?? null };
		case "--rev": {
			const rev = rest[0];
			if (rev === undefined) fail("--rev needs a rev (any commit git can resolve)");
			return { kind: "rollout", rev };
		}
		case "--rollback": {
			const rev = rest[0];
			if (rev === undefined) fail("--rollback needs a rev (an existing release)");
			return { kind: "rollback", rev };
		}
		case "--adopt-unit":
			return { kind: "adopt-unit", rev: rest[0] ?? null };
		default:
			fail(`unknown argument: ${first} (try --help)`);
	}
}

export async function main(argv: string[]): Promise<void> {
	const command = parseArgs(argv);
	if (command.kind === "help") {
		process.stdout.write(USAGE);
		return;
	}
	const ctx = await context();
	switch (command.kind) {
		case "status":
			await status(ctx);
			return;
		case "build": {
			const rev = await resolveRev(ctx.repo, command.rev);
			const dir = await buildRelease(ctx, rev);
			process.stdout.write(`built ${rev} at ${dir}\n`);
			return;
		}
		case "rollout":
		case "rollback":
		case "adopt-unit": {
			// Resolve once, under the lock: the release directory is named by the
			// resolved commit, so a branch that moves mid-rollout cannot split the
			// build from the flip.
			const release = await acquireLock(ctx.layout);
			try {
				const rev = await resolveRev(ctx.repo, "rev" in command ? command.rev : null);
				if (command.kind === "rollout") await rollout(ctx, rev);
				else if (command.kind === "rollback") await rollback(ctx, rev);
				else await adoptUnit(ctx, rev);
			} finally {
				release();
			}
		}
	}
}

if (import.meta.main) {
	try {
		await main(process.argv.slice(2));
	} catch (error) {
		if (error instanceof DeployError) {
			process.stderr.write(`deploy: FAILED — ${error.message}\n`);
		} else {
			process.stderr.write(`deploy: FAILED — ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		}
		process.exitCode = 1;
	}
}
