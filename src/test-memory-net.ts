import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const ENV_NAME = "GOBLIN_TEST_RSS_LIMIT_MB";
const SLOT_BYTES = 4 * 1024;
const CGROUP_ROOT = "/sys/fs/cgroup";

export function memoryLimit(
	env: string | undefined,
	cgroupMaxBytes: number | null,
): { bytes: number; why: string } {
	if (env !== undefined) {
		const parsed = Number(env);
		if (!/^\d+$/.test(env) || !Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
			throw new Error(`${ENV_NAME} must be a positive integer string; received ${JSON.stringify(env)}`);
		}
		return { bytes: parsed * MiB, why: `${ENV_NAME}=${env}` };
	}

	if (cgroupMaxBytes === null) return { bytes: 3 * GiB, why: "default 3 GiB" };
	const bytes = Math.min(3 * GiB, Math.floor(0.75 * cgroupMaxBytes));
	if (bytes === 3 * GiB) return { bytes, why: "default 3 GiB" };
	return {
		bytes,
		why: `75% of the ${formatBytes(cgroupMaxBytes)} cgroup limit`,
	};
}

function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`memory net could not read ${path}: ${String(error)}`, { cause: error });
	}
}

export function cgroupMemoryMax(): number | null {
	const contents = readText("/proc/self/cgroup");
	if (contents === null) return null;
	const cgroupPath = contents.split("\n").find((line) => line.startsWith("0::"))?.slice(3);
	if (cgroupPath === undefined) return null;

	const currentPath = resolve(CGROUP_ROOT, `.${cgroupPath}`);
	if (currentPath !== CGROUP_ROOT && !currentPath.startsWith(`${CGROUP_ROOT}/`)) {
		throw new Error(`memory net found an invalid cgroup path in /proc/self/cgroup: ${cgroupPath}`);
	}

	let path = currentPath;
	let smallest: number | null = null;
	for (;;) {
		const maxPath = resolve(path, "memory.max");
		const value = readText(maxPath);
		if (value !== null && value.trim() !== "max") {
			const text = value.trim();
			const bytes = Number(text);
			if (!/^\d+$/.test(text) || !Number.isFinite(bytes)) {
				throw new Error(`memory net found an invalid memory.max value at ${maxPath}: ${JSON.stringify(text)}`);
			}
			smallest = smallest === null ? bytes : Math.min(smallest, bytes);
		}
		if (path === CGROUP_ROOT) break;
		const parent = dirname(path);
		if (parent === path || !parent.startsWith(CGROUP_ROOT)) {
			throw new Error(`memory net could not walk cgroup parent from ${path}`);
		}
		path = parent;
	}
	return smallest;
}

const slotBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT + SLOT_BYTES);
const slotLength = new Int32Array(slotBuffer, 0, 1);
const slotBytes = new Uint8Array(slotBuffer, Int32Array.BYTES_PER_ELEMENT, SLOT_BYTES);
const encoder = new TextEncoder();
const describeNames: string[] = [];
let entered = false;
let currentTestName = "";
let currentTestLocation = "";

function writeSlot(text: string): void {
	const { written } = encoder.encodeInto(text, slotBytes);
	Atomics.store(slotLength, 0, written);
}

function sourceLocation(): string {
	const stack = new Error().stack ?? "";
	for (const line of stack.split("\n").slice(1)) {
		const frame = line.trim();
		const match =
			/\((.+):(\d+):(\d+)\)$/.exec(frame) ?? /^at\s+(.+):(\d+):(\d+)$/.exec(frame);
		if (match === null) continue;
		const stackPath = match[1] ?? "";
		const filePath = stackPath.startsWith("file://")
			? fileURLToPath(stackPath)
			: stackPath;
		if (
			!isAbsolute(filePath) ||
			filePath === import.meta.path ||
			filePath.startsWith("node:") ||
			filePath.startsWith("bun:")
		) {
			continue;
		}
		const pathFromRoot = relative(process.cwd(), filePath).replaceAll("\\", "/");
		if (pathFromRoot === "" || pathFromRoot.startsWith("../")) continue;
		return `${pathFromRoot}:${match[2]}`;
	}
	const preloadPath = relative(process.cwd(), import.meta.path).replaceAll("\\", "/");
	return `${preloadPath}:1`;
}

type RegistrationKind = "test" | "describe";
type Callable = (...args: unknown[]) => unknown;

function wrapCallback(
	callback: Callable,
	fullName: string,
	location: string,
): Callable {
	const wrapped: Callable = function (this: unknown, ...args: unknown[]): unknown {
		entered = true;
		currentTestName = fullName;
		currentTestLocation = location;
		writeSlot(`running: ${fullName}\n  registered at ${location}`);

		let waitForCompletion = wrapped.length > 0;
		try {
			const result: unknown = Reflect.apply(callback, this, args);
			if (isThenable(result)) {
				waitForCompletion = true;
				void Promise.resolve(result).then(
					() => writeAfter(),
					() => writeAfter(),
				);
			}
			return result;
		} finally {
			// Callback-style tests stay running until Bun's afterEach, after done.
			if (!waitForCompletion) writeAfter();
		}
	};
	Object.defineProperty(wrapped, "length", { value: callback.length });
	return wrapped;
}

function wrapRegistration(
	kind: RegistrationKind,
	original: Callable,
	boundThis?: unknown,
): Callable {
	return new Proxy(original, {
		apply(target, thisArg: unknown, args: unknown[]): unknown {
			const receiver = boundThis ?? thisArg;
			const name = args[0];
			const callback = args[1];
			if (typeof name !== "string" || typeof callback !== "function") {
				const result: unknown = Reflect.apply(target, receiver, args);
				return typeof result === "function"
					? wrapRegistration(kind, result as Callable, result)
					: result;
			}

			const location = sourceLocation();
			const fullName = [...describeNames, name].join(" > ");
			const filePath = location.slice(0, location.lastIndexOf(":"));
			writeSlot(`running: no test yet, loading ${filePath}`);

			if (kind === "describe") {
				const wrappedDescribe: Callable = function (
					this: unknown,
					...describeArgs: unknown[]
				): unknown {
					describeNames.push(name);
					try {
						return Reflect.apply(callback as Callable, this, describeArgs);
					} finally {
						describeNames.pop();
					}
				};
				Object.defineProperty(wrappedDescribe, "length", { value: callback.length });
				const wrappedArgs = [...args];
				wrappedArgs[1] = wrappedDescribe;
				return Reflect.apply(target, receiver, wrappedArgs);
			}

			const wrappedArgs = [...args];
			wrappedArgs[1] = wrapCallback(callback as Callable, fullName, location);
			const result: unknown = Reflect.apply(target, receiver, wrappedArgs);
			return typeof result === "function"
				? wrapRegistration(kind, result as Callable, result)
				: result;
		},
		get(target, property: string | symbol): unknown {
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function"
				? wrapRegistration(kind, value as Callable, target)
				: value;
		},
	});
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
	return typeof (value as { then?: unknown }).then === "function";
}

function writeAfter(): void {
	if (currentTestName === "") return;
	writeSlot(
		`running: between tests or in hooks, after ${JSON.stringify(currentTestName)}\n  registered at ${currentTestLocation}`,
	);
}

function formatBytes(bytes: number): string {
	if (bytes >= GiB) return `${(bytes / GiB).toFixed(2)} GiB`;
	return `${Math.round(bytes / MiB)} MiB`;
}

const envLimit = process.env[ENV_NAME];
const limit = memoryLimit(envLimit, envLimit === undefined ? cgroupMemoryMax() : null);
const bunTest = require("bun:test") as {
	test: Callable;
	it: Callable;
	describe: Callable;
	beforeEach: (fn: () => void) => void;
	afterEach: (fn: () => void) => void;
};

bunTest.test = wrapRegistration("test", bunTest.test);
bunTest.it = wrapRegistration("test", bunTest.it);
bunTest.describe = wrapRegistration("describe", bunTest.describe);

bunTest.beforeEach(() => {
	entered = false;
});
bunTest.afterEach(() => {
	if (!entered) {
		throw new Error(
			"memory net: this test did not run through the net's test wrapper, so a memory runaway could not name it. Something imported bun:test before src/test-memory-net.ts; keep it first in bunfig.toml (#818).",
		);
	}
	writeAfter();
});

const worker = new Worker(new URL("./test-memory-net.worker.ts", import.meta.url), {
	workerData: {
		limitBytes: limit.bytes,
		why: limit.why,
		slot: slotBuffer,
	} satisfies { limitBytes: number; why: string; slot: SharedArrayBuffer },
});

let workerReady = false;
const ready = new Promise<void>((resolveReady, rejectReady) => {
	worker.on("message", (message: unknown) => {
		if (
			typeof message === "object" &&
			message !== null &&
			"type" in message &&
			message.type === "ready"
		) {
			workerReady = true;
			resolveReady();
			return;
		}
		const error = new Error("memory net worker sent an unexpected startup message");
		if (workerReady) throw error;
		rejectReady(error);
	});
	worker.on("error", (error: Error) => {
		if (workerReady) throw new Error("memory net worker failed after startup", { cause: error });
		rejectReady(error);
	});
	worker.on("exit", (code: number) => {
		const error = new Error(`memory net worker exited unexpectedly with code ${code}`);
		if (workerReady) throw error;
		rejectReady(error);
	});
});

await ready;
worker.unref();
