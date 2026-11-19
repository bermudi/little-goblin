import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { installHcHooks } from "./hc-hooks.ts";

const roots: string[] = [];

function dir(): string {
	const path = mkdtempSync(join(tmpdir(), "goblin-hc-hooks-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		Bun.spawnSync(["trash", root]);
	}
});

describe("installHcHooks", () => {
	test("copies assets with mode 0755 and skips identical content", () => {
		const source = dir();
		const target = join(dir(), "installed");
		Bun.write(join(source, "report.sh"), "#!/bin/sh\nexit 0\n");

		installHcHooks(source, target);
		const path = join(target, "report.sh");
		const first = statSync(path);
		const mtime = first.mtimeMs;
		expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\nexit 0\n");
		expect(first.mode & 0o777).toBe(0o755);

		installHcHooks(source, target);
		expect(statSync(path).mtimeMs).toBe(mtime);
	});
});

// Each harness's blocked event must reach hc as these exact bytes.
const BLOCKED_PERMISSION = "\x1b]7501;state=blocked:kind=permission\x1b\\";
const BLOCKED_QUESTION = "\x1b]7501;state=blocked:kind=question\x1b\\";
const HOOKS_SOURCE = join(import.meta.dir, "..", "deploy", "hc-hooks");

// `script` gives the hook a pseudo-terminal of its own and copies what the
// hook writes to it onto stdout, so no test byte reaches the operator's tty.
function underPty(command: string, env: Record<string, string>): string {
	const out = Bun.spawnSync(["script", "-q", "-c", command, "/dev/null"], {
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
		stdin: "ignore",
	});
	expect(out.exitCode).toBe(0);
	return out.stdout.toString();
}

describe("report.sh", () => {
	test("writes the OSC 7501 state to the hook's terminal", () => {
		const hooks = join(dir(), "hooks");
		installHcHooks(HOOKS_SOURCE, hooks);
		expect(underPty(`${hooks}/report.sh blocked permission`, { GOBLIN_HC_RUN: "1" })).toBe(BLOCKED_PERMISSION);
		expect(underPty(`${hooks}/report.sh blocked question`, { GOBLIN_HC_RUN: "1" })).toBe(BLOCKED_QUESTION);
	});

	test("finds an ancestor's terminal when the hook has no controlling tty", () => {
		const hooks = join(dir(), "hooks");
		installHcHooks(HOOKS_SOURCE, hooks);
		// Claude runs hooks detached with captured stdio: no /dev/tty, no pts fds.
		const detached = `setsid -w ${hooks}/report.sh blocked permission </dev/null >/dev/null 2>&1`;
		expect(underPty(`sh -c '${detached}'`, { GOBLIN_HC_RUN: "1" })).toBe(BLOCKED_PERMISSION);
	});

	test("stays silent outside a goblin run", () => {
		const hooks = join(dir(), "hooks");
		installHcHooks(HOOKS_SOURCE, hooks);
		expect(underPty(`${hooks}/report.sh blocked permission`, {})).toBe("");
	});
});

// The JS hooks call GOBLIN_HC_REPORT; a recorder stands in for report.sh so
// the test sees the exact arguments.
function recorder(): { script: string; calls: () => string[][] } {
	const root = dir();
	const log = join(root, "calls");
	const script = join(root, "record.sh");
	writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
	chmodSync(script, 0o755);
	return {
		script,
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" ")) : []),
	};
}

function withHookEnv<T>(script: string, fn: () => Promise<T>): Promise<T> {
	const saved = { run: process.env.GOBLIN_HC_RUN, report: process.env.GOBLIN_HC_REPORT };
	process.env.GOBLIN_HC_RUN = "1";
	process.env.GOBLIN_HC_REPORT = script;
	return fn().finally(() => {
		if (saved.run === undefined) delete process.env.GOBLIN_HC_RUN;
		else process.env.GOBLIN_HC_RUN = saved.run;
		if (saved.report === undefined) delete process.env.GOBLIN_HC_REPORT;
		else process.env.GOBLIN_HC_REPORT = saved.report;
	});
}

describe("opencode tui plugin", () => {
	test("reports the run's state, blocked with its kind, and ignores subagent turns", async () => {
		const rec = recorder();
		type Event = { type: string; data: Record<string, unknown> };
		let emit: (event: Event) => void = () => {};
		const api = {
			data: {
				listen: (fn: (input: { details: Event }) => void) => {
					emit = (event) => fn({ details: event });
					return () => {};
				},
			},
		};
		const mod = (await import(join(HOOKS_SOURCE, "tui.js"))) as { default: { setup: (api: unknown) => void } };
		await withHookEnv(rec.script, async () => {
			mod.default.setup(api);
			emit({ type: "session.execution.started", data: { sessionID: "root" } });
			emit({ type: "session.created", data: { sessionID: "child", parentID: "root" } });
			emit({ type: "session.execution.succeeded", data: { sessionID: "child" } });
			emit({ type: "permission.asked", data: { id: "p1", sessionID: "child" } });
			emit({ type: "form.created", data: { form: { id: "f1", sessionID: "root" } } });
			emit({ type: "permission.replied", data: { requestID: "p1", sessionID: "child" } });
			emit({ type: "form.replied", data: { id: "f1", sessionID: "root" } });
			emit({ type: "session.execution.succeeded", data: { sessionID: "root" } });
		});
		expect(rec.calls()).toEqual([
			["idle"],
			["working"],
			["blocked", "permission"],
			["blocked", "question"],
			["working"],
			["idle"],
		]);
	});
});

describe("pi extension", () => {
	test("a blocked dialog reports blocked with its kind, and working once it clears", async () => {
		const rec = recorder();
		type Handler = (event: unknown, ctx: { mode?: string; isIdle?: () => boolean }) => void;
		const handlers = new Map<string, Handler>();
		const bus = new Map<string, (data: unknown) => void>();
		const pi = {
			on: (name: string, fn: Handler) => handlers.set(name, fn),
			events: { on: (name: string, fn: (data: unknown) => void) => bus.set(name, fn) },
		};
		const mod = (await import(join(HOOKS_SOURCE, "pi-extension.mjs"))) as { default: (pi: unknown) => void };
		mod.default(pi);
		await withHookEnv(rec.script, async () => {
			handlers.get("session_start")?.({}, { mode: "tui" });
			bus.get("herdr:blocked")?.({ active: true, kind: "question" });
			bus.get("herdr:blocked")?.({ active: true, kind: "permission" });
			bus.get("herdr:blocked")?.({ active: false });
			bus.get("herdr:blocked")?.({ active: false });
		});
		expect(rec.calls()).toEqual([["idle"], ["blocked", "question"], ["blocked", "permission"], ["working"]]);
	});
});
