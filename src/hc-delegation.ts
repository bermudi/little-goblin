import type { Hc, HcTerminal } from "./hc.ts";
import { HcError } from "./hc.ts";
import { makeHarnessInvocation } from "./hc-harness.ts";
import { ensureHcCore, hcSessionForHome } from "./hc.ts";
import { installHcHooks } from "./hc-hooks.ts";
import { goblinHome } from "./goblin-home.ts";
import { paths } from "./home-layout.ts";

export { HcError } from "./hc.ts";

export interface HcRunInfo {
	agent: string;
	agent_status: string;
	name: string;
	state_change_seq: number;
	completion_seq?: number;
	cwd: string;
}

export interface HcDelegation {
	start(name: string, kind: string, cwd: string, args: string[]): Promise<HcRunInfo>;
	get(name: string): Promise<HcRunInfo | null>;
	prompt(name: string, text: string): Promise<void>;
	sendKey(name: string, key: string): Promise<void>;
	read(name: string, lines: number): Promise<string>;
	interrupt(name: string): Promise<void>;
	kill(name: string): Promise<void>;
}

export function attachHintFor(name: string | null | undefined): string {
	return `HC_SESSION=${hcSessionForHome(goblinHome())} ${paths.hcBinary()} attach ${name ?? "<terminal>"}`;
}

function asRun(terminal: HcTerminal): HcRunInfo {
	const state = terminal.status?.state ?? "unknown";
	const seq = terminal.status_ms ?? terminal.turn;
	return {
		agent: terminal.argv[0] ?? "unknown",
		agent_status: state,
		name: terminal.name ?? terminal.address,
		state_change_seq: seq,
		...(state === "done" ? { completion_seq: seq } : {}),
		cwd: terminal.cwd,
	};
}

export function makeHcDelegation(input: {
	hc: Hc;
	goblinHome: string;
	hooksDir: string;
}): HcDelegation {
	const get = async (name: string): Promise<HcRunInfo | null> => {
		const terminal = await input.hc.get(name);
		return terminal === null ? null : asRun(terminal);
	};
	return {
		async start(name, kind, cwd, args) {
			installHcHooks(`${import.meta.dir}/../deploy/hc-hooks`, input.hooksDir);
			await ensureHcCore(paths.hcBinary(), hcSessionForHome(input.goblinHome));
			const invocation = makeHarnessInvocation({
				kind,
				args,
				cwd,
				terminalName: name,
				goblinHome: input.goblinHome,
				hooksDir: input.hooksDir,
			});
			const terminal = await input.hc.run({
				name,
				cwd,
				argv: invocation.argv,
				env: invocation.env,
			});
			let info = asRun(terminal);
			const deadline = Date.now() + 30_000;
			while (info.agent_status === "unknown" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 200));
				const current = await get(name);
				if (current === null) throw new HcError("terminal.get", `terminal disappeared during startup: ${name}`);
				info = current;
			}
			if (info.agent_status === "blocked") {
				throw new HcError("terminal.run", "harness is blocked during startup", "agent_not_ready");
			}
			if (info.agent_status === "unknown") {
				throw new HcError("terminal.get", `no hook status within 30 seconds for ${name}`, "agent_status_timeout");
			}
			return info;
		},
		get,
		async prompt(name, text) {
			const before = await get(name);
			if (before?.agent_status === "blocked") {
				throw new HcError("terminal.send", "terminal is blocked", "agent_blocked");
			}
			await input.hc.send(name, text);
			if (before === null || before === undefined || before.agent_status !== "idle") return;
			const end = Date.now() + 30_000;
			while (Date.now() < end) {
				await new Promise((resolve) => setTimeout(resolve, 200));
				const current = await get(name);
				if (current === null) throw new HcError("terminal.get", `terminal disappeared after send: ${name}`);
				if (["working", "blocked", "done"].includes(current.agent_status)) return;
			}
			throw new HcError("terminal.send", `no working status after sending to ${name}`, "agent_prompt_unsubmitted");
		},
		async sendKey(name, key) {
			await input.hc.keys(name, [key]);
		},
		read(name, lines) {
			return input.hc.read(name, lines);
		},
		async interrupt(name) {
			await input.hc.keys(name, ["CTRL+C"]);
		},
		async kill(name) {
			const terminal = await input.hc.get(name);
			if (terminal !== null) await input.hc.kill(name);
		},
	};
}
