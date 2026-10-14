// The script tool's worker entry (design/tools.md → Scripting), a thin
// bound in front of the pinned upstream worker. Upstream posts every
// tool call the VM makes and the host's cap/semaphore only run after
// the message lands and its args parse — an unawaited-call loop would
// flood the port first. This wrapper patches parentPort.postMessage,
// then imports the upstream entry: serialized args cap at 1 MiB,
// accepted calls at maxCalls, posted-outstanding calls at 8 (the rest
// queue inside the worker and flush as results free slots). The first
// violation crashes the script once and trips the shared interrupt, so
// a catch/retry loop can't keep posting; no calls/output are forwarded after
// done/crash/abort — an unawaited queued call never reaches the host.
//
// maxCalls travels in workerData.code: the host prepends a private
// one-line header that this wrapper validates, strips, and drops — the
// eval then sees the script exactly as written, line numbers included.
// Missing or bad header = a loud crash, never an unbounded run.

import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { z } from "zod";

/** The URL hosts pass as CodemodeSandbox's workerUrl. */
export const SCRIPT_WORKER_URL = new URL(import.meta.url);

const HEADER_PREFIX = "__goblin_script_worker__:";
const headerSchema = z
	.object({ v: z.literal(1), maxCalls: z.number().int().min(1).max(500) })
	.strict();

/** Host side: prepend the private worker config header to the script
 *  source the VM will eval. The worker strips the whole first line. */
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
	// Strip the header — newline included — so the eval's line 1 is the
	// script's line 1, exactly as if the code arrived unwrapped.
	(data as { code: string }).code = code.slice(nl + 1);

	// Bound underneath the upstream post(): only calls are governed —
	// output items are already capped inside the VM and done/crash are
	// terminal bookkeeping.
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
	// Loud once, then silent: the interrupt kills running VM code and
	// every later post — a catch/retry loop's — is dropped.
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
			// A host interrupt fences work, but upstream still owns its terminal message.
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

	// Registered before the upstream import so it runs first: the freed
	// slot is visible and queued calls are posted before the settle
	// re-enters the VM and drains.
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
