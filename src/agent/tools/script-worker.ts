import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { z } from "zod";

export const SCRIPT_WORKER_URL = new URL(import.meta.url);

const HEADER_PREFIX = "__goblin_script_worker__:";
const headerSchema = z
	.object({ v: z.literal(1), maxCalls: z.number().int().min(1).max(500) })
	.strict();

export function encodeScriptWorkerCode(code: string, maxCalls: number): string {
	return `${HEADER_PREFIX}${JSON.stringify({ v: 1, maxCalls })}\n${code}`;
}

const MAX_CALL_ARG_BYTES = 1024 * 1024;
const MAX_POSTED_CALLS = 8;

function messageType(message: unknown): unknown {
	if (typeof message !== "object" || message === null) return undefined;
	return (message as { type?: unknown }).type;
}

async function boot(port: MessagePort, data: unknown): Promise<void> {
	const crash = (message: string): void => {
		port.postMessage({ type: "crash", message });
	};
	if (typeof data !== "object" || data === null) {
		return crash("script worker: workerData is not an object");
	}
	const code = (data as { code?: unknown }).code;
	if (typeof code !== "string" || !code.startsWith(HEADER_PREFIX)) {
		return crash("script worker: missing the host config header — refusing to run unbounded");
	}
	const nl = code.indexOf("\n");
	if (nl < 0) return crash("script worker: malformed config header");
	let config: { v: 1; maxCalls: number };
	try {
		config = headerSchema.parse(JSON.parse(code.slice(HEADER_PREFIX.length, nl)));
	} catch (err) {
		return crash(
			`script worker: bad config header (${err instanceof Error ? err.message : String(err)})`,
		);
	}
	const interruptRaw = (data as { interrupt?: unknown }).interrupt;
	if (!(interruptRaw instanceof SharedArrayBuffer) || interruptRaw.byteLength < 4) {
		return crash("script worker: missing the shared interrupt");
	}
	const interrupt = new Int32Array(interruptRaw);
	// Strip header incl. newline so the eval's line 1 is the script's line 1.
	(data as { code: string }).code = code.slice(nl + 1);

	const post = port.postMessage.bind(port) as (message: unknown) => void;
	let accepted = 0;
	const outstanding = new Set<number>();
	const queue: unknown[] = [];
	let dead = false;
	const interrupted = (): boolean => Atomics.load(interrupt, 0) !== 0;
	const stop = (): void => {
		dead = true;
		queue.length = 0;
	};
	const trip = (message: string): void => {
		stop();
		Atomics.store(interrupt, 0, 1);
		post({ type: "crash", message });
	};
	const flush = (): void => {
		while (!dead && outstanding.size < MAX_POSTED_CALLS && queue.length > 0) {
			const next = queue.shift();
			const id = (next as { id?: unknown }).id;
			if (typeof id === "number") outstanding.add(id);
			post(next);
		}
	};

	port.postMessage = (message: unknown): void => {
		if (dead) return;
		const type = messageType(message);
		if (type === "done" || type === "crash") {
			stop();
			post(message);
			return;
		}
		if (interrupted()) {
			queue.length = 0;
			return;
		}
		if (type !== "call") {
			post(message);
			return;
		}
		const args = (message as { args?: unknown }).args;
		const argBytes = typeof args === "string" ? Buffer.byteLength(args, "utf8") : 0;
		if (argBytes > MAX_CALL_ARG_BYTES) {
			return trip(
				`tool call arguments exceed the ${MAX_CALL_ARG_BYTES / (1024 * 1024)} MiB serialized limit — the script is stopped, not just the call`,
			);
		}
		accepted += 1;
		if (accepted > config.maxCalls) {
			return trip(
				`tool call limit exceeded — the script attempted more than ${config.maxCalls} calls and is stopped, not just rejected`,
			);
		}
		if (outstanding.size >= MAX_POSTED_CALLS) {
			queue.push(message);
			return;
		}
		const id = (message as { id?: unknown }).id;
		if (typeof id === "number") outstanding.add(id);
		post(message);
	};

	// Registered before the upstream import so queued calls flush before the VM drains.
	port.on("message", (message: unknown) => {
		if (dead) return;
		if (interrupted()) {
			queue.length = 0;
			return;
		}
		if (messageType(message) === "result") {
			const id = (message as { id?: unknown }).id;
			if (typeof id === "number") outstanding.delete(id);
			flush();
		}
	});

	try {
		await import("@earendil-works/pi-codemode/worker");
	} catch (err) {
		crash(
			`script worker: the pinned upstream worker failed to load — ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

if (parentPort !== null) {
	void boot(parentPort, workerData);
}
