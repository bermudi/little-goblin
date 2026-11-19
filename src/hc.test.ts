import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { symlinkSync } from "node:fs";
import { hcSessionForHome, HcError, makeHc } from "./hc.ts";
import { useHome } from "./testkit.ts";

const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve, reject) =>
			server.close((err) => (err ? reject(err) : resolve())),
		);
	}
});

test("run validates the core reply and terminal calls use JSON-RPC", async () => {
	const socketPath = join(useHome("goblin-hc-"), "core.sock");
	let callCount = 0;
	const server = createServer((connection) => {
		let buffer = "";
		connection.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(buffer.slice(0, newline)) as {
				id: string;
				method: string;
				params: Record<string, unknown>;
			};
			callCount += 1;
			const result =
				request.method === "terminal.run"
					? {
							address: "t1",
							argv: request.params.argv,
							cwd: request.params.cwd,
							exit_code: null,
							name: request.params.name,
							pid: 42,
							state: "live",
							status: null,
							status_ms: null,
							turn: 0,
						}
					: request.method === "terminal.get"
						? {
								address: "t1",
								argv: ["/bin/sh"],
								cwd: "/work",
								exit_code: null,
								name: "delegate-1",
								pid: 42,
								state: "live",
								status: { state: "working" },
								status_ms: 123,
								turn: 1,
							}
						: request.method === "terminal.read"
							? { text: "output", complete: true, how: "screen" }
							: {};
			connection.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) =>
		server.listen(socketPath, () => resolve()).once("error", reject),
	);
	const hc = makeHc("probe", { path: socketPath });

	const launched = await hc.run({
		name: "delegate-1",
		cwd: "/work",
		argv: ["/bin/sh"],
		env: { GOBLIN_HC_RUN: "1" },
	});
	expect(launched.address).toBe("t1");
	expect((await hc.get("delegate-1"))?.status?.state).toBe("working");
	expect(await hc.read("t1", 20)).toBe("output");
	expect(callCount).toBe(3);
});

test("malformed replies and unavailable sockets fail as typed hc errors", async () => {
	const home = useHome("goblin-hc-error-");
	const socketPath = join(home, "bad.sock");
	const server = createServer((connection) => {
		connection.once("data", (chunk) => {
			const request = JSON.parse(chunk.toString("utf8")) as { id: string };
			connection.end(`${JSON.stringify({
				jsonrpc: "2.0",
				id: request.id,
				result: { terminals: [{ state: "unexpected" }] },
			})}\n`);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) =>
		server.listen(socketPath, () => resolve()).once("error", reject),
	);
	await expect(makeHc("bad-reply", { path: socketPath }).list()).rejects.toMatchObject({
		name: "HcError",
		method: "terminal.list",
		code: "invalid_reply",
	});

	await expect(makeHc("missing", { path: join(home, "missing.sock") }).list()).rejects.toMatchObject({
		name: "HcError",
		method: "terminal.list",
		code: "transport_error",
	});
});

test("a typed terminal-not-found reply maps to null", async () => {
	const socketPath = join(useHome("goblin-hc-not-found-"), "core.sock");
	const server = createServer((connection) => {
		connection.once("data", (chunk) => {
			const request = JSON.parse(chunk.toString("utf8")) as { id: string };
			connection.end(`${JSON.stringify({
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32004, message: "terminal does not exist", data: { kind: "not_found" } },
			})}\n`);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) =>
		server.listen(socketPath, () => resolve()).once("error", reject),
	);
	expect(await makeHc("missing-terminal", { path: socketPath }).get("gone")).toBeNull();
});

test("session identity follows the real path of a symlinked home", () => {
	const home = useHome("goblin-hc-home-");
	const link = join(useHome("goblin-hc-link-"), "home");
	symlinkSync(home, link);
	expect(hcSessionForHome(link)).toBe(hcSessionForHome(home));
});

test("missing runtime directory is a typed error at call time", async () => {
	const old = process.env.XDG_RUNTIME_DIR;
	delete process.env.XDG_RUNTIME_DIR;
	try {
		await expect(makeHc("unreachable").list()).rejects.toMatchObject({
			name: "HcError",
			method: "connect",
			code: "runtime_dir_missing",
		});
	} finally {
		if (old !== undefined) process.env.XDG_RUNTIME_DIR = old;
	}
});
