import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const SLOT_BYTES = 4 * 1024;

type WorkerConfig = {
	limitBytes: number;
	why: string;
	slot: SharedArrayBuffer;
};

function parseWorkerConfig(value: unknown): WorkerConfig {
	if (typeof value !== "object" || value === null) {
		throw new Error("memory net worker received invalid worker data");
	}
	if (
		!("limitBytes" in value) ||
		typeof value.limitBytes !== "number" ||
		!Number.isFinite(value.limitBytes) ||
		value.limitBytes < 0 ||
		!("why" in value) ||
		typeof value.why !== "string" ||
		!("slot" in value) ||
		!(value.slot instanceof SharedArrayBuffer) ||
		value.slot.byteLength !== Int32Array.BYTES_PER_ELEMENT + SLOT_BYTES
	) {
		throw new Error("memory net worker received malformed worker data");
	}
	return {
		limitBytes: value.limitBytes,
		why: value.why,
		slot: value.slot,
	};
}

function formatBytes(bytes: number): string {
	if (bytes >= GiB) return `${(bytes / GiB).toFixed(2)} GiB`;
	return `${Math.round(bytes / MiB)} MiB`;
}

const config = parseWorkerConfig(workerData as unknown);
const slotLength = new Int32Array(config.slot, 0, 1);
const slotBytes = new Uint8Array(config.slot, Int32Array.BYTES_PER_ELEMENT, SLOT_BYTES);
const decoder = new TextDecoder();
if (parentPort === null) throw new Error("memory net worker has no parent port");

function runningTest(): string {
	const length = Atomics.load(slotLength, 0);
	if (length <= 0 || length > slotBytes.byteLength) {
		return "running: no test registered yet (a preload?)";
	}
	return decoder.decode(slotBytes.subarray(0, length));
}

const poll = setInterval(() => {
	const rss = process.memoryUsage.rss();
	if (rss < config.limitBytes) return;
	clearInterval(poll);
	const message = [
		`memory runaway: bun test process ${process.pid} reached ${formatBytes(rss)} RSS, over its ${formatBytes(config.limitBytes)} limit (${config.why}).`,
		runningTest(),
		"The process is stuck in synchronous work that keeps allocating, so bun cannot fail the test itself.",
		"A common cause is bun printing a huge object graph for a failed assertion (#798). Killing it (SIGKILL) before the kernel does.",
		"",
	].join("\n");
	writeSync(2, message);
	process.kill(process.pid, "SIGKILL");
}, 100);

parentPort.postMessage({ type: "ready" });
