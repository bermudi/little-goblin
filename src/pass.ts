import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { BoundaryError } from "./boundary-error.ts";
import { log } from "./log.ts";
import { boundedRun } from "./proc.ts";

const PASS_TIMEOUT_MS = 30_000;
const PASS_MAX_OUTPUT = 64 * 1024;
const ITEM_MAX_OUTPUT = 1 << 20;
const STDERR_LINE_CAP = 200;
const REASON_CAP = 300;

export interface PassRef {
	vault: string;
	item: string;
	field: string;
}

export function parsePassRef(text: string): PassRef | null {
	if (!text.startsWith("pass://")) return null;
	if (text.includes("?") || text.includes("#")) return null;
	const parts = text.slice("pass://".length).split("/");
	if (parts.length !== 3 || parts.some((part) => part === "")) return null;
	return { vault: parts[0]!, item: parts[1]!, field: parts[2]! };
}

export function formatPassRef(ref: PassRef): string {
	return `pass://${ref.vault}/${ref.item}/${ref.field}`;
}

export interface PassLane {
	readField(ref: PassRef, reason: string): Promise<string>;
}

const renewals = new Map<string, Promise<void>>();

function realOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function firstLine(text: string): string {
	return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim().slice(0, STDERR_LINE_CAP);
}

function spawnWithEnv(argv: string[], env: Record<string, string | undefined>): Bun.ReadableSubprocess {
	return Bun.spawn(argv, {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
}

export function makePassLane(options: {
	goblinHome: string;
	home: string;
	loginProfile: string;
}): PassLane {
	const sessionDir = join(options.goblinHome, "state", "pass-cli-task");
	const ownerDir = join(options.home, ".local", "share", "proton-pass-cli");

	const passEnv = (withSession: boolean, reason?: string): Record<string, string | undefined> => {
		const env: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!key.startsWith("PROTON_PASS_")) env[key] = value;
		}
		env.PATH = `${options.home}/bin:${options.home}/.local/bin:${process.env.PATH ?? ""}`;
		if (withSession) env.PROTON_PASS_SESSION_DIR = sessionDir;
		if (reason !== undefined) env.PROTON_PASS_AGENT_REASON = reason.slice(0, REASON_CAP);
		return env;
	};

	const guardSessionDir = (): void => {
		if (realOrResolved(sessionDir) === realOrResolved(ownerDir)) {
			throw new BoundaryError("pass", "fatal", "the pass task session dir resolves to the owner session dir — refusing to use it");
		}
		mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	};

	const run = (argv: string[], env: Record<string, string | undefined>, maxOutput = PASS_MAX_OUTPUT) =>
		boundedRun(spawnWithEnv(argv, env), { timeoutMs: PASS_TIMEOUT_MS, maxOutput });

	const agentSession = async (): Promise<boolean> => {
		const r = await run(["pass-cli", "info"], passEnv(true));
		if (r.timedOut || r.exitCode !== 0) return false;
		return r.stdout.includes("Personal Access Token") && r.stdout.includes("[Agent]");
	};

	const ensureSession = async (): Promise<void> => {
		const inFlight = renewals.get(sessionDir);
		if (inFlight !== undefined) return inFlight;
		const renewal = (async () => {
			if (await agentSession()) return;
			const login = await run(["pass-keys", "login", options.loginProfile], passEnv(false));
			log.info("pass session renewal", { profile: options.loginProfile, ok: login.exitCode === 0 });
			if (await agentSession()) return;
			throw new BoundaryError(
				"pass",
				"fatal",
				`pass task session could not be renewed — ${firstLine(login.stderr) || `pass-keys exited ${login.exitCode ?? "after a timeout"}`}`,
			);
		})();
		renewals.set(sessionDir, renewal);
		try {
			return await renewal;
		} finally {
			if (renewals.get(sessionDir) === renewal) renewals.delete(sessionDir);
		}
	};

	return {
		async readField(ref: PassRef, reason: string): Promise<string> {
			guardSessionDir();
			await ensureSession();
			const r = await run(
				["pass-cli", "item", "view", formatPassRef(ref)],
				passEnv(true, reason),
				ITEM_MAX_OUTPUT,
			);
			const ok = !r.timedOut && r.exitCode === 0;
			log.info("pass item view", { vault: ref.vault, item: ref.item, field: ref.field, ok });
			if (r.timedOut) {
				throw new BoundaryError("pass", "transient", `pass-cli item view timed out after ${PASS_TIMEOUT_MS}ms`);
			}
			if (r.exitCode !== 0) {
				throw new BoundaryError("pass", "fatal", firstLine(r.stderr) || `pass-cli exited ${r.exitCode ?? "unknown"}`);
			}
			return r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout;
		},
	};
}
