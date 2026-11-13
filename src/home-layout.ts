// The $GOBLIN_HOME layout: every path goblin owns, durable directory
// creation, first-boot seeding, and the workspace entry-point shims.

import {
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	statSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { authFile } from "./auth-parse.ts";
import { durableWriteFile } from "./durable.ts";
import { goblinHome } from "./goblin-home.ts";
import { log } from "./log.ts";

export const paths = {
	config: () => join(goblinHome(), "goblin.json5"),
	auth: authFile,
	mcporter: () => join(goblinHome(), "mcporter.json"),
	mcpShim: () => join(goblinHome(), "mcp"),
	goblinMailShim: () => join(goblinHome(), "goblin-mail"),
	doctorShim: () => join(goblinHome(), "doctor"),
	workspace: () => join(goblinHome(), "workspace"),
	// The claude-code child CLI's CLAUDE_CONFIG_DIR — all of its state
	// (config, scratch, telemetry ids) lives under goblin's state tree,
	// never ~/.claude.
	claudeCodeState: () => join(goblinHome(), "state", "claude-code"),
	soul: () => join(goblinHome(), "workspace", "SOUL.md"),
	agents: () => join(goblinHome(), "workspace", "AGENTS.md"),
	user: () => join(goblinHome(), "workspace", "USER.md"),
	skills: () => join(goblinHome(), "workspace", "skills"),
	// The skill reviewer's parking area: validated auto-saves wait here
	// for the operator's yes — never in the catalog itself.
	skillsProposed: () => join(goblinHome(), "workspace", "skills-proposed"),
	attachments: () => join(goblinHome(), "workspace", "attachments"),
	state: () => join(goblinHome(), "state"),
	db: () => join(goblinHome(), "state", "goblin.sqlite"),
	logFile: () => join(goblinHome(), "state", "goblin.log"),
	delegations: () => join(goblinHome(), "state", "delegations"),
	modelsDevCache: () => join(goblinHome(), "state", "models.dev.json"),
	// Goblin's own ChatGPT OAuth tokens from in-app sign-in — ~/.codex
	// stays the codex CLI's file, this one is ours.
	codexAuth: () => join(goblinHome(), "state", "codex-auth.json"),
	// Per-auth-file codex catalog — the key is the auth-path hash
	// (src/agent/codex/models.ts), so two accounts never share a file.
	codexModelsCache: (key: string) => join(goblinHome(), "state", `codex-models-${key}.json`),
	openrouterModelsCache: () => join(goblinHome(), "state", "openrouter-models.json"),
	webcache: () => join(goblinHome(), "state", "webcache"),
	scriptcache: () => join(goblinHome(), "state", "scriptcache"),
	bashcache: () => join(goblinHome(), "state", "bashcache"),
	// Digest-pinned fetched temp skills — cache, not state: deletable,
	// never a catalog entry.
	skillcache: () => join(goblinHome(), "state", "skillcache"),
	// Lazy: created on the first project create, not by ensureHomeLayout.
	projects: () => join(goblinHome(), "projects"),
	// Digest-pinned auto-fetch artifacts. Cache, not state: deletable.
	whistleCache: () => join(goblinHome(), "cache", "whistle"),
};

// One layout directory, durably: missing ancestors are created
// oldest-first, each parent fsynced — a WAL commit can't protect a
// file inside a directory that vanishes on first-boot power loss.
export function ensureDir(dir: string): void {
	const missing: string[] = [];
	for (let next = dir; ; next = dirname(next)) {
		try {
			if (!statSync(next).isDirectory())
				throw new Error(`layout directory is not a directory: ${next}`);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			missing.unshift(next);
			if (dirname(next) === next) throw new Error(`no existing parent for ${dir}`);
		}
	}
	for (const next of missing) {
		mkdirSync(next);
		const parent = openSync(dirname(next), constants.O_RDONLY);
		try {
			fsyncSync(parent);
		} finally {
			closeSync(parent);
		}
	}
}

export function ensureHomeLayout(): void {
	for (const dir of [
		goblinHome(),
		paths.workspace(),
		paths.skills(),
		paths.skillsProposed(),
		paths.attachments(),
		paths.state(),
	]) {
		ensureDir(dir);
	}
	seedFile(
		paths.soul(),
		[
			"# SOUL.md",
			"",
			"You are goblin, a personal AI agent living in Telegram. You serve one",
			"operator. You are direct, competent, and terse by default — this is a",
			"chat, not a report generator. You have a shell, a filesystem, and",
			"opinions. Use them.",
			"",
		].join("\n"),
	);
	seedFile(
		paths.agents(),
		[
			"# AGENTS.md",
			"",
			"Your operating notes. Each conversation starts from this file and",
			"nothing else — it is your only memory between them. Write things down:",
			"",
			'- Operator says "remember this" → it goes here.',
			"- Operator states a lasting preference → it goes in USER.md in",
			"  its directive format, not here.",
			"- You learn a deployment fact (a path, a host, a service, where",
			"  things live on this machine) → it goes here.",
			"- You make a mistake you could repeat → the lesson goes here.",
			"- A rule stops being true → replace it in place. Never keep two",
			"  rules that contradict.",
			"",
			"Facts, not plans. Short lines. No secrets. Read before writing —",
			"update what exists instead of stacking a new entry.",
			"",
		].join("\n"),
	);
	// Repo-shipped skills: a rebuilt box regains the capability without prompting.
	for (const skill of ["browser", "pass-cli", "mcp", "gws", "herdr"]) {
		mkdirSync(join(paths.skills(), skill), { recursive: true });
		const template = readFileSync(
			join(import.meta.dir, "..", "deploy", "skills", skill, "SKILL.md"),
			"utf8",
		);
		seedFile(join(paths.skills(), skill, "SKILL.md"), template);
	}
	// The seed's `"imports": []` is load-bearing: without it mcporter
	// merges the operator's editor servers.
	seedFile(
		paths.mcporter(),
		[
			"{",
			'\t// Goblin\'s own MCP servers (DESIGN.md, "Web access" → "MCP").',
			"\t// Secrets are ${VAR} placeholders only — values ride the",
			"\t// goblin-mcp-dev pass-keys profile into mcporter's child env,",
			'\t// never this file. "imports" MUST stay []: without it',
			"\t// mcporter merges the operator's editor servers, and the",
			"\t// call-time gate refuses anything else.",
			'\t"mcpServers": {},',
			'\t"imports": []',
			"}",
			"",
		].join("\n"),
	);
	refreshMcpShim();
	refreshGoblinMailShim();
	refreshDoctorShim();
	seedFile(
		paths.user(),
		[
			"# USER.md",
			"",
			"Your model of the operator — stable preferences and facts they",
			"would endorse, one directive per entry:",
			"",
			"<!-- observed: YYYY-MM-DD | status: active -->",
			"- Always/Never/Prefer …",
			"",
			"When a preference changes, mark the old entry superseded and write",
			"the replacement — never two active directives that contradict.",
			"Date every entry. An empty file is correct until something real is",
			"learned; don't invent entries to fill it.",
			"",
		].join("\n"),
	);
}

// First-boot scaffolding: create iff absent — operator and agent edits
// are never clobbered. Stubs, not just standing instructions: a model
// edits a file in its prompt head but won't create one out of nothing.
function seedFile(path: string, content: string): void {
	if (existsSync(path)) return;
	durableWriteFile(path, content, 0o644);
}

// Workspace bash can't see the repo, so the `mcp` skill's entry point is
// a symlink — repo updates propagate, repointed every boot. A real file
// in the way refuses loud: a missing shim is degraded, not fatal.
function refreshMcpShim(): void {
	const shim = paths.mcpShim();
	const target = join(import.meta.dir, "..", "scripts", "mcp");
	let isLink: boolean | null = null;
	try {
		isLink = lstatSync(shim).isSymbolicLink();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (isLink === null) {
		symlinkSync(target, shim);
		return;
	}
	if (!isLink) {
		log.error("not clobbering the mcp shim: a real file is in the way", undefined, { path: shim });
		return;
	}
	if (readlinkSync(shim) !== target) {
		unlinkSync(shim);
		symlinkSync(target, shim);
	}
}

// The `goblin-mail` skill's entry point — same symlink-not-copy contract
// as the mcp shim above.
function refreshGoblinMailShim(): void {
	const shim = paths.goblinMailShim();
	const target = join(import.meta.dir, "..", "scripts", "goblin-mail");
	let isLink: boolean | null = null;
	try {
		isLink = lstatSync(shim).isSymbolicLink();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (isLink === null) {
		symlinkSync(target, shim);
		return;
	}
	if (!isLink) {
		log.error("not clobbering the goblin-mail shim: a real file is in the way", undefined, {
			path: shim,
		});
		return;
	}
	if (readlinkSync(shim) !== target) {
		unlinkSync(shim);
		symlinkSync(target, shim);
	}
}

function refreshDoctorShim(): void {
	const shim = paths.doctorShim();
	const target = join(import.meta.dir, "..", "scripts", "doctor");
	let isLink: boolean | null = null;
	try {
		isLink = lstatSync(shim).isSymbolicLink();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (isLink === null) {
		symlinkSync(target, shim);
		return;
	}
	if (!isLink) {
		log.error("not clobbering the doctor shim: a real file is in the way", undefined, {
			path: shim,
		});
		return;
	}
	if (readlinkSync(shim) !== target) {
		unlinkSync(shim);
		symlinkSync(target, shim);
	}
}
