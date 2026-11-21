import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { durableWriteFile } from "./durable.ts";
import { log } from "./log.ts";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const hookState = {
	idle: "idle",
	working: "working",
	done: "idle",
	blocked: "blocked",
	error: "error",
} as const;

type JsonObject = Record<string, unknown>;

function readJsonObject(path: string): JsonObject {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(`${path}: invalid JSON; fix by hand before delegation`, { cause: err });
	}
	const result = jsonObjectSchema.safeParse(parsed);
	if (!result.success) throw new Error(`${path}: expected a JSON object; refusing to overwrite`);
	return result.data;
}

function writeJson(path: string, value: JsonObject): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	durableWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

function hashCodexHook(event: string, command: string): string {
	const eventName = event.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/^_/, "");
	const hook = { async: false, command, timeout: 600, type: "command" };
	const payload = JSON.stringify({ event_name: eventName, hooks: [hook] });
	return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function tomlString(value: string): string {
	return `"${value.replace(/[\\"\x00-\x1f\x7f]/g, (char) => {
		if (char === "\\") return "\\\\";
		if (char === '"') return '\\"';
		return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
	})}"`;
}

export function ensureCodexHooks(hooksDir: string, home = process.env.CODEX_HOME ?? join(homedir(), ".codex")): void {
	const hookFile = join(home, "hooks.json");
	const configFile = join(home, "config.toml");
	const hookDoc = readJsonObject(hookFile);
	const desired = [
		["SessionStart", "idle", ""],
		["UserPromptSubmit", "working", ""],
		["PreToolUse", "working", ""],
		["PostToolUse", "working", ""],
		["Stop", "idle", ""],
		["PermissionRequest", "blocked", " permission"],
	] as const;
	let hookChanged = false;
	const trustTables: string[] = [];
	for (const [event, state, extra] of desired) {
		const command = `${join(hooksDir, "report.sh")} ${state}${extra}`;
		const rawEntries = hookDoc[event] ?? [];
		const parsedEntries = z.array(z.unknown()).safeParse(rawEntries);
		if (!parsedEntries.success) throw new Error(`${hookFile}: ${event} must be an array`);
		const entries = [...parsedEntries.data];
		let foundIndex = -1;
		let foundHookIndex = 0;
		for (const [entryIndex, entry] of entries.entries()) {
			if (typeof entry !== "object" || entry === null || !("hooks" in entry)) continue;
			const list = (entry as { hooks?: unknown }).hooks;
			if (!Array.isArray(list)) continue;
			const hookIndex = list.findIndex((item) =>
				typeof item === "object" && item !== null && "command" in item &&
				(item as { command?: unknown }).command === command);
			if (hookIndex >= 0) {
				foundIndex = entryIndex;
				foundHookIndex = hookIndex;
				break;
			}
		}
		const eventIndex = foundIndex >= 0 ? foundIndex : entries.length;
		if (foundIndex < 0) {
			entries.push({ hooks: [{ type: "command", command }] });
			hookDoc[event] = entries;
			hookChanged = true;
		}
		const eventName = event.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/^_/, "");
		const key = `${hookFile}:${eventName}:${eventIndex}:${foundIndex >= 0 ? foundHookIndex : 0}`;
		trustTables.push(
			`[hooks.state.${tomlString(key)}]\ntrusted_hash = ${tomlString(hashCodexHook(event, command))}\n`,
		);
	}
	if (hookChanged) writeJson(hookFile, hookDoc);

	let toml = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
	let parsed: unknown;
	try {
		parsed = toml.trim() === "" ? {} : Bun.TOML.parse(toml);
	} catch (err) {
		throw new Error(`${configFile}: invalid TOML; fix by hand before delegation`, { cause: err });
	}
	const root = jsonObjectSchema.safeParse(parsed);
	if (!root.success) throw new Error(`${configFile}: expected a TOML table`);
	const features = root.data.features;
	if (features !== undefined && (typeof features !== "object" || features === null || Array.isArray(features))) {
		throw new Error(`${configFile}: features is not a TOML table`);
	}
	const enabled = (features as JsonObject | undefined)?.hooks;
	if (enabled === false) throw new Error(`${configFile}: hooks=false; enable Codex hooks before delegation`);
	if (enabled !== true) {
		if (features === undefined) toml = `${toml.trimEnd()}\n\n[features]\nhooks = true\n`;
		else {
			const header = /^\s*\[features\]\s*$/m;
			const match = header.exec(toml);
			if (!match) throw new Error(`${configFile}: features table cannot be extended safely`);
			const insert = match.index + match[0].length;
			toml = `${toml.slice(0, insert)}\nhooks = true${toml.slice(insert)}`;
		}
	}
	for (const table of trustTables) {
		const header = table.slice(0, table.indexOf("\n"));
		if (!toml.includes(header)) toml = `${toml.trimEnd()}\n\n${table}`;
	}
	const nextToml = toml.endsWith("\n") ? toml : `${toml}\n`;
	if (nextToml !== (existsSync(configFile) ? readFileSync(configFile, "utf8") : "")) {
		durableWriteFile(configFile, nextToml, 0o600);
	}
	log.info("Codex lifecycle hooks merged", { hooks: desired.length, home });
}

function writeClaudeSettings(stateDir: string, hooksDir: string, terminalName: string): string {
	const path = join(stateDir, "hc-hooks", `${terminalName}-claude.json`);
	const command = (state: string) => `${join(hooksDir, "report.sh")} ${state}`;
	writeJson(path, {
		hooks: {
			SessionStart: [{ hooks: [{ type: "command", command: command("idle"), timeout: 10 }] }],
			UserPromptSubmit: [{ hooks: [{ type: "command", command: command("working"), timeout: 10 }] }],
			PreToolUse: [{ hooks: [{ type: "command", command: command("working"), timeout: 10 }] }],
			PostToolUse: [{ hooks: [{ type: "command", command: command("working"), timeout: 10 }] }],
			Stop: [{ hooks: [{ type: "command", command: command("idle"), timeout: 10 }] }],
			Notification: [{
				matcher: "permission_prompt",
				hooks: [{ type: "command", command: command("blocked permission"), timeout: 10 }],
			}],
		},
	});
	return path;
}

function devinOperatorConfigPath(home: string): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config");
	return join(base, "devin", "config.json");
}

const devinConfigSchema = z.looseObject({
	hooks: z.record(z.string(), z.array(z.unknown())).optional(),
});

function readDevinOperatorConfig(path: string): z.infer<typeof devinConfigSchema> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
		throw new Error(`${path}: cannot read devin config`, { cause: err });
	}
	let parsed: unknown;
	try {
		parsed = Bun.JSONC.parse(text);
	} catch (err) {
		throw new Error(`${path}: invalid JSONC; fix by hand before delegation`, { cause: err });
	}
	const result = devinConfigSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(`${path}: expected an object whose hooks map events to arrays`, { cause: result.error });
	}
	return result.data;
}

function hasHookCommand(entries: unknown[], command: string): boolean {
	return entries.some((entry) => {
		if (typeof entry !== "object" || entry === null) return false;
		const list = (entry as { hooks?: unknown }).hooks;
		return Array.isArray(list) && list.some((hook) =>
			typeof hook === "object" && hook !== null && (hook as { command?: unknown }).command === command);
	});
}

function writeDevinConfig(stateDir: string, hooksDir: string, terminalName: string, home: string): string {
	const path = join(stateDir, "hc-hooks", `${terminalName}-devin.json`);
	const source = devinOperatorConfigPath(home);
	const config = readDevinOperatorConfig(source);
	const hooks: Record<string, unknown[]> = { ...config.hooks };
	const command = (state: string) => `${join(hooksDir, "report.sh")} ${state}`;
	const desired = [
		["SessionStart", "idle"],
		["UserPromptSubmit", "working"],
		["PreToolUse", "working"],
		["PostToolUse", "working"],
		["Stop", "idle"],
		["PermissionRequest", "blocked permission"],
	] as const;
	for (const [event, state] of desired) {
		const entries = hooks[event] ?? [];
		if (hasHookCommand(entries, command(state))) continue;
		hooks[event] = [...entries, { hooks: [{ type: "command", command: command(state), timeout: 10 }] }];
	}
	writeJson(path, { ...config, hooks });
	log.info("devin per-run config written", {
		path,
		source,
		operatorKeys: Object.keys(config).length,
		events: desired.length,
	});
	return path;
}

export interface HarnessInvocation {
	argv: string[];
	env: Record<string, string>;
}

export function makeHarnessInvocation(input: {
	kind: string;
	args: string[];
	cwd: string;
	terminalName: string;
	goblinHome: string;
	hooksDir: string;
}): HarnessInvocation {
	const commands: Record<string, string> = {
		codex: "codex",
		claude: "claude",
		pi: "pi",
		opencode: "opencode",
		devin: "devin",
	};
	const command = commands[input.kind];
	if (!command) throw new Error(`unsupported delegation harness kind: ${input.kind}`);
	const executable = Bun.which(command, { PATH: process.env.PATH ?? "" });
	if (!executable) throw new Error(`cannot resolve ${command} on Goblin's PATH`);

	const argv = [executable, ...input.args];
	const home = process.env.HOME ?? homedir();
	const env: Record<string, string> = {
		GOBLIN_HC_RUN: "1",
		GOBLIN_HC_REPORT: join(input.hooksDir, "report.sh"),
		HOME: home,
		PATH: process.env.PATH ?? "/usr/bin:/bin",
	};
	const stateDir = join(input.goblinHome, "state");
	if (input.kind === "codex") {
		if (!input.args.includes("--no-daemon")) argv.push("--no-daemon");
		// The update prompt draws before any hook fires, so start would time
		// out on it; a per-run override leaves the operator's config alone.
		argv.push("-c", "check_for_update_on_startup=false");
		const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
		env.CODEX_HOME = codexHome;
		ensureCodexHooks(input.hooksDir, codexHome);
	} else if (input.kind === "claude") {
		argv.push("--settings", writeClaudeSettings(stateDir, input.hooksDir, input.terminalName));
	} else if (input.kind === "pi") {
		argv.push("--extension", join(input.hooksDir, "pi-extension.mjs"));
	} else if (input.kind === "opencode") {
		// A shared background service would mix in other sessions' events;
		// --standalone gives the run a private server. The hooks directory is
		// the plugin: OpenCode v2 loads its tui.js inside this terminal.
		// The TUI rejects --model and `mini` loads no plugins (#742), so a
		// configured --model/-m moves into the per-run config instead.
		let model: string | undefined;
		const args: string[] = [];
		for (let i = 0; i < input.args.length; i++) {
			const arg = input.args[i]!;
			if (arg.startsWith("--model=")) model = arg.slice("--model=".length);
			else if (arg === "--model" || arg === "-m") {
				model = input.args[++i];
				if (model === undefined) throw new Error(`opencode harness: ${arg} needs a model`);
			} else args.push(arg);
		}
		argv.splice(1, input.args.length, ...args);
		if (!args.includes("--standalone")) argv.push("--standalone");
		env.OPENCODE_CLI_CONFIG_CONTENT = JSON.stringify({
			plugins: [input.hooksDir],
			...(model === undefined ? {} : { model }),
		});
	} else if (input.kind === "devin") {
		argv.push("--config", writeDevinConfig(stateDir, input.hooksDir, input.terminalName, home));
	}
	log.info("delegation harness invocation prepared", {
		kind: input.kind,
		executable,
		cwd: input.cwd,
		terminal: input.terminalName,
	});
	return { argv, env };
}
