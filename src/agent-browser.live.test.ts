// Live wire check: pins the real agent-browser CLI's contract for the two
// calls the adapter makes — `mcp call agent_browser_eval` returning
// location.href of the frame element commands run in, and
// `mcp call agent_browser_fill` taking {"selector","text"} on stdin so the
// value never sits in argv.
//     GOBLIN_AB_LIVE=1 bun test src/agent-browser.live.test.ts
// Run it after an agent-browser upgrade; red means the interface moved:
// re-pin the shapes, then fix src/agent-browser.ts.
// Everything runs in a throwaway `--session` against a Bun.serve loopback
// page with a FAKE value; the session is closed when the run ends.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { makeAgentBrowser } from "./agent-browser.ts";

const LIVE = process.env.GOBLIN_AB_LIVE === "1";
const SESSION = "goblin-ab-live";
const FAKE = "FAKE-pw-123";

const ab = (args: string[]): string =>
	execSync(
		["agent-browser", "--session", SESSION, ...args.map((a) => `'${a.replaceAll("'", "'\\''")}'`)].join(" "),
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);

const PAGE =
	'<!doctype html><html><body><form><input id="pw" type="password" name="password"></form></body></html>';
const SERVER_JS = `const s=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response(${JSON.stringify(PAGE)},{headers:{"content-type":"text/html"}})});console.log(s.port)`;

describe.skipIf(!LIVE)("agent-browser live wire", () => {
	let server: Bun.Subprocess | undefined;
	let url = "";
	const browser = makeAgentBrowser();

	beforeAll(async () => {
		// The page is served from a child process: execSync'd CLI calls block
		// this process's loop, so an in-process Bun.serve could never answer.
		server = Bun.spawn(["bun", "-e", SERVER_JS], { stdout: "pipe", stderr: "inherit" });
		const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buf = "";
		while (!buf.includes("\n")) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
		}
		void reader.cancel().catch(() => {});
		reader.releaseLock();
		const port = Number(buf.trim().split("\n")[0]);
		if (!Number.isSafeInteger(port) || port < 1) throw new Error(`server child printed ${JSON.stringify(buf)}`);
		url = `http://127.0.0.1:${port}/`;
		ab(["open", url]);
	}, 60_000);

	afterAll(() => {
		try {
			ab(["close"]);
		} finally {
			server?.kill();
		}
	}, 30_000);

	test("pageUrl returns the session page's location.href", async () => {
		expect(await browser.pageUrl(SESSION)).toBe(url);
	}, 30_000);

	test("fill by snapshot @ref and by CSS selector lands the value", async () => {
		const snapshot = ab(["snapshot", "-i"]);
		const ref = /ref=(e\d+)/.exec(snapshot)?.[1];
		expect(ref, `no ref in:\n${snapshot}`).toBeTruthy();

		expect(await browser.fill(`@${ref!}`, FAKE, SESSION)).toEqual({ ok: true });
		expect(ab(["get", "value", "#pw"])).toContain(FAKE);

		expect(await browser.fill("#pw", `${FAKE}-css`, SESSION)).toEqual({ ok: true });
		expect(ab(["get", "value", "#pw"])).toContain(`${FAKE}-css`);
	}, 60_000);
});
