import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ensureHcCore, hcSessionForHome, makeHc, stopHcCore } from "./hc.ts";
import { useHome } from "./testkit.ts";

const active: { binary: string; session: string }[] = [];

afterEach(() => {
	for (const core of active.splice(0)) stopHcCore(core.binary, core.session);
});

test("pinned hc core runs, reads, sends to, and kills a terminal", async () => {
	if (process.env.GOBLIN_HC_LIVE !== "1") {
		throw new Error("set GOBLIN_HC_LIVE=1 to run the disposable hc live check");
	}
	const home = useHome("goblin-hc-live-");
	const binary = join(home, "bin", "herdr-core");
	const session = `${hcSessionForHome(home)}-live`;
	const inheritedSentinel = process.env.GOBLIN_HC_SENTINEL;
	process.env.GOBLIN_HC_SENTINEL = "leak";
	try {
		await ensureHcCore(binary, session);
	} finally {
		if (inheritedSentinel === undefined) delete process.env.GOBLIN_HC_SENTINEL;
		else process.env.GOBLIN_HC_SENTINEL = inheritedSentinel;
	}
	active.push({ binary, session });
	const hc = makeHc(session);
	const terminalName = `live-${process.pid}`;
	const terminal = await hc.run({
		name: terminalName,
		cwd: home,
		argv: ["/bin/sh", "-c", "printf 'ready\\n'; read line; printf 'got:%s\\n' \"$line\"; sleep 5"],
		env: {},
	});
	try {
		expect(terminal.name).toBe(terminalName);
		expect((await hc.get(terminalName))?.state).toBe("live");
		const sentinel = await hc.run({
			name: `${terminalName}-env`,
			cwd: home,
			argv: ["/bin/sh", "-c", `printf '%s' "\${GOBLIN_HC_SENTINEL-unset}"`],
			env: {},
		});
		const sentinelName = sentinel.name ?? `${terminalName}-env`;
		let sentinelOutput = "";
		const sentinelDeadline = Date.now() + 5_000;
		while (Date.now() < sentinelDeadline) {
			sentinelOutput = await hc.read(sentinelName, 5);
			if (sentinelOutput.length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(sentinelOutput).toBe("unset");
		await hc.kill(sentinelName);
		const readyDeadline = Date.now() + 5_000;
		while (Date.now() < readyDeadline && !(await hc.read(terminalName, 20)).includes("ready")) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(await hc.read(terminalName, 20)).toContain("ready");
		await hc.send(terminalName, "probe-input");
		let output = "";
		const outputDeadline = Date.now() + 5_000;
		while (Date.now() < outputDeadline) {
			output = await hc.read(terminalName, 20);
			if (output.includes("got:probe-input")) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(output).toContain("got:probe-input");
		await hc.kill(terminalName);
		expect((await hc.get(terminalName))?.state).toBe("finished");
	} finally {
		const current = await hc.get(terminalName);
		if (current?.state === "live") await hc.kill(terminalName);
		const sentinelTerminal = await hc.get(`${terminalName}-env`);
		if (sentinelTerminal?.state === "live") await hc.kill(`${terminalName}-env`);
	}
}, 30_000);
