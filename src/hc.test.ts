import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { makeHc } from "./hc.ts";
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
