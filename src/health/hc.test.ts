import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { hcSessionForHome, hcSocketPath } from "../hc.ts";
import { HC_VERSION } from "../hc-install.ts";
import { clearHcSetupFailure, failHcSetup } from "../hc-setup-failure.ts";
import { tmpDir, useHome, waitUntil } from "../testkit.ts";
import { hcCore } from "./hc.ts";

// The check runs against the real pin; tests stand in a small file and pass
// its hash as the pin, since the 0.1.21 binary is not in the repo.
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fakeBinary = Buffer.from("#!/bin/sh\necho fake herdr-core\n");
const retiredBinary = Buffer.from("#!/bin/sh\necho older herdr-core\n");
const pins = {
	current: { version: HC_VERSION, binarySha256: sha256(fakeBinary) },
	retired: [{ version: "0.0.9-retired", binarySha256: sha256(retiredBinary) }],
};

const inheritedRuntime = process.env.XDG_RUNTIME_DIR;
const servers: Server[] = [];
let home = "";

beforeEach(() => {
	home = useHome("goblin-hc-health-");
	process.env.XDG_RUNTIME_DIR = tmpDir("goblin-hc-run-");
});

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
	}
	if (inheritedRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = inheritedRuntime;
});

function installBinary(bytes: Uint8Array = fakeBinary): void {
	mkdirSync(join(home, "bin"), { recursive: true });
	writeFileSync(join(home, "bin", "herdr-core"), bytes, { mode: 0o755 });
}

function socketPath(): string {
	const path = hcSocketPath(hcSessionForHome(home));
	mkdirSync(join(path, ".."), { recursive: true });
	return path;
}

async function serveCore(reply: (id: string, method: string) => string): Promise<void> {
	const server = createServer((connection) => {
		let buffer = "";
		connection.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string };
			connection.end(`${reply(request.id, request.method)}\n`);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => server.listen(socketPath(), () => resolve()).once("error", reject));
}

const check = () => hcCore(home, true, pins);

test("skips when delegation is not configured", async () => {
	expect(await hcCore("/missing/home", false)).toMatchObject({ id: "delegation.hc", status: "skip" });
});

test("ready before the first run: binary not installed yet passes", async () => {
	const result = await check();
	expect(result).toMatchObject({ id: "delegation.hc", status: "pass" });
	expect(result.detail).toContain("not installed yet; the first delegate run downloads and verifies it");
});

test("ready after a reboot: pinned binary with no core running passes", async () => {
	installBinary();
	const result = await check();
	expect(result).toMatchObject({ status: "pass" });
	expect(result.detail).toContain("is not running and starts on the first delegate run");
});

test("a pinned binary that cannot execute stays red", async () => {
	installBinary();
	chmodSync(join(home, "bin", "herdr-core"), 0o644);
	const result = await check();
	expect(result).toMatchObject({ status: "fail" });
	expect(result.detail).toContain("is not executable");
});

test("a reachable core passes with its terminal count", async () => {
	installBinary();
	await serveCore((id, method) => JSON.stringify({
		jsonrpc: "2.0",
		id,
		result: method === "terminal.list" ? { terminals: [] } : { version: HC_VERSION },
	}));
	const result = await check();
	expect(result).toMatchObject({ status: "pass" });
	expect(result.detail).toContain(`installed herdr-core ${HC_VERSION} matches the pin`);
	expect(result.detail).toContain(`running herdr-core ${HC_VERSION}; 0 terminals`);
});

test("after a pin bump, a retired-pin binary passes and names its replacement", async () => {
	installBinary(retiredBinary);
	const result = await check();
	expect(result).toMatchObject({ status: "pass" });
	expect(result.detail).toContain(`herdr-core 0.0.9-retired is a retired pin; the next delegate run replaces it with ${HC_VERSION}`);
	expect(result.detail).toContain("is not running and starts on the first delegate run");
});

test("after a pin bump, a retired-pin binary with a reachable core passes", async () => {
	installBinary(retiredBinary);
	await serveCore((id, method) => JSON.stringify({
		jsonrpc: "2.0",
		id,
		result: method === "terminal.list" ? { terminals: [] } : { version: HC_VERSION },
	}));
	const result = await check();
	expect(result).toMatchObject({ status: "pass" });
	expect(result.detail).toContain("herdr-core 0.0.9-retired is a retired pin");
	expect(result.detail).toContain(`running herdr-core ${HC_VERSION}; 0 terminals`);
});

test("a running retired core warns even when the installed binary is current", async () => {
	installBinary();
	await serveCore((id, method) => JSON.stringify({
		jsonrpc: "2.0",
		id,
		result: method === "terminal.list" ? { terminals: [] } : { version: "0.0.9-retired" },
	}));
	const result = await check();
	expect(result).toMatchObject({ status: "warn" });
	expect(result.detail).toContain(`running herdr-core 0.0.9-retired is retired; pinned herdr-core is ${HC_VERSION}`);
	expect(result.detail).toContain("0 terminals");
	expect(result.next).toContain("next core start");
	expect(result.next).toContain("Doctor does not start or stop it");
});

test("a running core at an unrecognized valid version warns without calling it retired", async () => {
	installBinary();
	await serveCore((id, method) => JSON.stringify({
		jsonrpc: "2.0",
		id,
		result: method === "terminal.list" ? { terminals: [] } : { version: "0.1.19" },
	}));
	const result = await check();
	expect(result).toMatchObject({ status: "warn" });
	expect(result.detail).toContain(`running herdr-core 0.1.19 does not match pinned ${HC_VERSION}`);
	expect(result.detail).not.toContain("retired");
});

test.each([
	["missing version", { other: "0.1.21" }],
	["invalid version", { version: "untrusted server output" }],
])("a core with %s status fails safely", async (_name, status) => {
	installBinary();
	await serveCore((id, method) => JSON.stringify({
		jsonrpc: "2.0",
		id,
		result: method === "terminal.list" ? { terminals: [] } : status,
	}));
	const result = await check();
	expect(result).toMatchObject({ status: "fail" });
	expect(result.detail).toContain("server.status failed");
	expect(result.detail).not.toContain("untrusted server output");
});

test("a server.status RPC error fails safely", async () => {
	installBinary();
	await serveCore((id, method) => method === "terminal.list"
		? JSON.stringify({ jsonrpc: "2.0", id, result: { terminals: [] } })
		: JSON.stringify({
			jsonrpc: "2.0",
			id,
			error: { code: -1, message: "private core detail", data: { kind: "untrusted server output" } },
		}));
	const result = await check();
	expect(result).toMatchObject({ status: "fail" });
	expect(result.detail).toContain("server.status failed; cannot verify the running version");
	expect(result.detail).not.toContain("private core detail");
	expect(result.detail).not.toContain("untrusted server output");
});

test("a binary that matches no pin stays red, even with retired pins known", async () => {
	installBinary(Buffer.from("tampered"));
	const result = await check();
	expect(result).toMatchObject({ status: "fail" });
	expect(result.detail).toBe(`herdr-core binary does not match the pinned ${HC_VERSION} hash or any retired pin`);
	expect(result.next).toContain("tampered or corrupt");
});

test("a herdr-core path that is not a file stays red", async () => {
	mkdirSync(join(home, "bin", "herdr-core"), { recursive: true });
	expect(await check()).toMatchObject({ status: "fail", detail: "herdr-core path is not a regular file" });
});

test("a failed download stays red until a run succeeds", async () => {
	const record = join(home, "state", "hc-setup-failure.json");
	const cause = new Error("could not download pinned hc 0.1.21");
	expect(() => failHcSetup(record, "install", cause)).toThrow(cause);
	const failed = await check();
	expect(failed).toMatchObject({ status: "fail" });
	expect(failed.detail).toContain("The last delegate run could not install pinned herdr-core");
	expect(failed.next).toContain("hc binary install failed");

	clearHcSetupFailure(record);
	expect(existsSync(record)).toBe(false);
	expect((await check()).status).toBe("pass");
});

test("a setup failure recorded for an older pin does not keep the check red", async () => {
	mkdirSync(join(home, "state"), { recursive: true });
	writeFileSync(
		join(home, "state", "hc-setup-failure.json"),
		`${JSON.stringify({ stage: "install", version: "0.0.1-old", at: "2026-11-01T00:00:00.000Z" })}\n`,
	);
	expect((await check()).status).toBe("pass");
});

test("a core that would not start stays red, even with a verified binary", async () => {
	installBinary();
	const cause = new Error("systemd-run could not start hc (1)");
	expect(() => failHcSetup(join(home, "state", "hc-setup-failure.json"), "start", cause)).toThrow(cause);
	const result = await check();
	expect(result).toMatchObject({ status: "fail" });
	expect(result.detail).toContain("could not start the hc core");
	expect(result.next).toContain("hc core start failed");
});

test("a running core that answers wrongly stays red", async () => {
	installBinary();
	await serveCore(() => "not json");
	const result = await check();
	expect(result).toMatchObject({ status: "fail" });
	expect(result.detail).toContain("terminal.list failed: hc_error");
});

test("a core that died without stopping warns, not passes", async () => {
	installBinary();
	const path = socketPath();
	const core = Bun.spawn(
		["bun", "-e", `require("node:net").createServer().listen(${JSON.stringify(path)})`],
		{ stdout: "ignore", stderr: "inherit" },
	);
	await waitUntil(() => existsSync(path), "dying core binds its socket");
	core.kill("SIGKILL");
	await core.exited;
	expect(existsSync(path)).toBe(true);
	const result = await check();
	expect(result).toMatchObject({ status: "warn" });
	expect(result.detail).toContain("refuses connections");
});
