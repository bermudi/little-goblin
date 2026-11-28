import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeAgentBrowser } from "./agent-browser.ts";
import { tmpDir } from "./testkit.ts";

const AGENT_BROWSER = `#!/usr/bin/env bash
printf 'argv:' >> "$FAKE_STATE/ab.log"; printf ' %s' "$@" >> "$FAKE_STATE/ab.log"; printf '\\n' >> "$FAKE_STATE/ab.log"
printf 'session=%s\\n' "\${AGENT_BROWSER_SESSION-unset}" >> "$FAKE_STATE/env.log"
input=$(cat)
printf 'stdin:%s\\n' "$input" >> "$FAKE_STATE/ab.log"
if [ "$3" = "agent_browser_fill" ]; then
	if [ -f "$FAKE_STATE/fill-fails" ]; then
		printf '{"structuredContent":{"response":{"success":false,"error":"Unknown ref: e2"}}}\\n'
		exit 1
	fi
	printf '{"structuredContent":{"response":{"success":true}}}\\n'
	exit 0
fi
if [ "$3" = "agent_browser_eval" ]; then
	printf '{"structuredContent":{"response":{"success":true,"data":{"result":"https://example.com/login"}}}}\\n'
	exit 0
fi
exit 2
`;

function read(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

const saved = process.env.FAKE_STATE;
afterEach(() => {
	if (saved === undefined) delete process.env.FAKE_STATE;
	else process.env.FAKE_STATE = saved;
});

function rig() {
	const home = tmpDir("ab-home-");
	const state = tmpDir("ab-fake-state-");
	mkdirSync(join(home, "bin"), { recursive: true });
	writeFileSync(join(home, "bin", "agent-browser"), AGENT_BROWSER, { mode: 0o755 });
	process.env.FAKE_STATE = state;
	process.env.PATH = `${join(home, "bin")}:${process.env.PATH ?? ""}`;
	return { state, browser: makeAgentBrowser() };
}

const savedPath = process.env.PATH;
afterEach(() => {
	if (savedPath === undefined) delete process.env.PATH;
	else process.env.PATH = savedPath;
});

describe("agent-browser adapter", () => {
	test("fill sends the JSON on stdin, never in argv, with the session env only when given", async () => {
		const r = rig();
		expect(await r.browser.fill("@e2", "SECRET-pw-9", "mysession")).toEqual({ ok: true });
		const log = read(join(r.state, "ab.log"));
		expect(log).toContain("argv: mcp call agent_browser_fill -\n");
		expect(log.split("\n").filter((line) => line.startsWith("argv:")).join("")).not.toContain("SECRET-pw-9");
		expect(log).toContain('stdin:{"selector":"@e2","text":"SECRET-pw-9"}');
		expect(read(join(r.state, "env.log"))).toContain("session=mysession");

		await r.browser.fill("@e3", "x");
		expect(read(join(r.state, "env.log"))).toContain("session=unset");
	});

	test("fill failure carries the response error", async () => {
		const r = rig();
		writeFileSync(join(r.state, "fill-fails"), "");
		expect(await r.browser.fill("@e2", "SECRET-pw-9")).toEqual({ ok: false, error: "Unknown ref: e2" });
	});

	test("pageUrl returns the evaluated location.href", async () => {
		const r = rig();
		expect(await r.browser.pageUrl("s1")).toBe("https://example.com/login");
		const log = read(join(r.state, "ab.log"));
		expect(log).toContain("argv: mcp call agent_browser_eval -\n");
		expect(log).toContain('stdin:{"script":"location.href"}');
	});
});
