import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { encodeScriptWorkerCode, SCRIPT_WORKER_URL } from "./script-worker.ts";

for (const code of [
	"tools.bash({}); while (true) {}",
	"await tools.bash({}); text('suppressed'); tools.bash({}); return 'interrupted';",
]) {
	test(`a host interrupt preserves the worker's terminal message: ${code}`, async () => {
		const interrupt = new Int32Array(new SharedArrayBuffer(4));
		const worker = new Worker(SCRIPT_WORKER_URL, {
			workerData: {
				code: encodeScriptWorkerCode(code, 10),
				tools: [{ name: "bash", jsName: "bash", description: "" }],
				globals: [],
				store: {},
				wasm: await loadQuickJSWasm(),
				memoryLimitBytes: 256 * 1024 * 1024,
				interrupt: interrupt.buffer,
			},
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const messages: unknown[] = [];
		try {
			const terminal = await new Promise<unknown>((resolve, reject) => {
				timer = setTimeout(() => reject(new Error("worker lost its terminal message")), 2_000);
				worker.on("error", reject);
				worker.on("message", (message: unknown) => {
					if (typeof message !== "object" || message === null) {
						reject(new Error("unexpected worker message"));
						return;
					}
					const type = (message as { type?: unknown }).type;
					messages.push(type);
					if (type === "call") {
						Atomics.store(interrupt, 0, 1);
						worker.postMessage({
							type: "result",
							id: (message as { id?: unknown }).id,
							ok: true,
							payload: '"finished"',
						});
					} else if (type === "done" || type === "crash") {
						resolve(message);
					}
				});
			});
			expect(messages).toEqual(["call", expect.stringMatching(/^(done|crash)$/)]);
			expect(terminal).toMatchObject({
				type: expect.stringMatching(/^(done|crash)$/),
			});
		} finally {
			clearTimeout(timer);
			Atomics.store(interrupt, 0, 1);
			await worker.terminate();
		}
	});
}
