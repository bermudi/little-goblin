import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { makeHc, hcSessionForHome, stopHcCore } from "./hc.ts";
import { makeHcDelegation } from "./hc-delegation.ts";
import { seedHarnessTrust } from "./harness-trust.ts";
import { paths } from "./home-layout.ts";
import { tmpDir, useHome } from "./testkit.ts";

const LIVE = process.env.GOBLIN_DEVIN_LIVE === "1";
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;
const savedEnv: Record<string, string | undefined> = {};
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const operatorConfigSchema = z.looseObject({
	agent: z.looseObject({ model: z.string().optional() }).optional(),
});

describe.skipIf(!LIVE)("devin live delegation (GOBLIN_DEVIN_LIVE=1)", () => {
	test("operator settings and hooks survive; Goblin's hooks report working then idle (#810)", async () => {
		const realHome = homedir();
		const goblinHome = useHome("goblin-devin-live-");
		const home = tmpDir("goblin-devin-live-home-");
		const cwd = tmpDir("goblin-devin-live-cwd-");
		const events = join(home, "events.log");

		mkdirSync(join(home, ".local", "share", "devin"), { recursive: true });
		copyFileSync(
			join(realHome, ".local", "share", "devin", "credentials.toml"),
			join(home, ".local", "share", "devin", "credentials.toml"),
		);
		const operator = operatorConfigSchema.parse(
			Bun.JSONC.parse(readFileSync(join(realHome, ".config", "devin", "config.json"), "utf8")),
		);
		const probeHooks = Object.fromEntries(EVENTS.map((event) => [event, [{
			hooks: [{ type: "command", command: `echo ${event} >> ${events}`, timeout: 10 }],
		}]]));
		mkdirSync(join(home, ".config", "devin"), { recursive: true });
		writeFileSync(
			join(home, ".config", "devin", "config.json"),
			JSON.stringify({ ...operator, hooks: probeHooks }),
			{ mode: 0o600 },
		);
		writeFileSync(join(cwd, "hello.txt"), "goblin-810-marker\n");

		for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		process.env.HOME = home;

		const session = hcSessionForHome(goblinHome);
		const hc = makeHc(session);
		const delegation = makeHcDelegation({ hc, goblinHome, hooksDir: paths.hcHooks() });
		const name = `live-devin-${process.pid}`;
		cleanups.push(() => stopHcCore(paths.hcBinary(), session));
		cleanups.push(async () => {
			await delegation.kill(name).catch(() => undefined);
		});

		seedHarnessTrust("devin", cwd, home);
		const started = await delegation.start(name, "devin", cwd, []);
		expect(started.agent_status).toBe("idle");

		const perRun = operatorConfigSchema.parse(
			JSON.parse(readFileSync(join(goblinHome, "state", "hc-hooks", `${name}-devin.json`), "utf8")),
		);
		expect(perRun.agent?.model === operator.agent?.model).toBe(true);

		const ownStates: string[] = [];
		const watch = (async () => {
			const deadline = performance.now() + 120_000;
			while (performance.now() < deadline) {
				const status = (await hc.get(name))?.status;
				if (status && status.app === undefined && ownStates.at(-1) !== status.state) ownStates.push(status.state);
				if (ownStates.includes("working") && ownStates.at(-1) === "idle") return;
				await Bun.sleep(100);
			}
		})();
		await delegation.prompt(name, "Read the file hello.txt in this folder and reply with its first line only.");
		await watch;
		expect(ownStates.slice(ownStates.indexOf("working"))).toEqual(["working", "idle"]);
		expect([...new Set(readFileSync(events, "utf8").trim().split("\n"))].sort()).toEqual([...EVENTS].sort());

		if (operator.agent?.model !== undefined) {
			const logDir = join(home, ".local", "share", "devin", "cli", "logs");
			const logs = existsSync(logDir)
				? readdirSync(logDir).map((file) => readFileSync(join(logDir, file), "utf8")).join("\n")
				: "";
			const resolved = /resolved_model_uid=(\S+) Model resolution complete/.exec(logs)?.[1];
			expect(resolved !== undefined && resolved === operator.agent.model).toBe(true);
		}
	}, 240_000);
});
