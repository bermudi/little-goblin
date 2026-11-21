import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { tmpDir } from "../../../../src/testkit.ts";

async function withFakeServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
	const dir = tmpDir("verify-fake-model-");
	const portFile = join(dir, "port");
	const server = Bun.spawn(
		["bun", "--no-env-file", join(import.meta.dir, "fake-model.ts"), portFile],
		{ stdout: "ignore", stderr: "ignore" },
	);
	try {
		let port: number | null = null;
		for (let attempt = 0; attempt < 200; attempt += 1) {
			if (existsSync(portFile)) {
				port = Number(readFileSync(portFile, "utf8"));
				break;
			}
			await Bun.sleep(10);
		}
		if (port === null || !Number.isSafeInteger(port) || port < 1)
			throw new Error("fake model did not publish its port");
		return await run(`http://127.0.0.1:${port}`);
	} finally {
		server.kill("SIGTERM");
		await server.exited;
	}
}

test("fake System1 endpoint scores the exact serialized checkState shape", async () => {
	await withFakeServer(async (baseUrl) => {
		const request = (next: string) =>
			fetch(`${baseUrl}/api/alpha/decisions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "fake-decision-model",
					state: JSON.stringify({ next }),
					questions: {
						follow_up: {
							type: "noul",
							instructions: "Check whether it follows up.",
							criteria: { true: "Same subject.", false: "New subject." },
						},
					},
				}),
			});
		const fresh = await request("[new topic] another subject");
		expect(fresh.status).toBe(200);
		expect(await fresh.json()).toEqual({
			answers: { follow_up: { type: "noul", noul: 0.05 } },
		});
		const continuation = await request("and one more detail");
		expect(continuation.status).toBe(200);
		expect(await continuation.json()).toEqual({
			answers: { follow_up: { type: "noul", noul: 0.9 } },
		});
	});
});

test("fake System1 endpoint rejects a non-string or malformed state", async () => {
	await withFakeServer(async (baseUrl) => {
		const invalid = await fetch(`${baseUrl}/api/alpha/decisions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "fake", state: { next: "[new topic]" }, questions: {} }),
		});
		expect(invalid.status).toBe(400);
		const malformed = await fetch(`${baseUrl}/api/alpha/decisions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "fake", state: "{", questions: {} }),
		});
		expect(malformed.status).toBe(400);
	});
});
