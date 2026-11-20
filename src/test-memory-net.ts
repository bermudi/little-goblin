import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { format } from "node:util";
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
let slotText = "";
let entered = false;
let currentTestName = "";
let currentTestLocation = "";

function writeSlot(text: string): void {
	slotText = text;
	const { written } = encoder.encodeInto(text, slotBytes);
	Atomics.store(slotLength, 0, written);
}

interface RegistrationLocation {
	file: string | null;
	text: string;
}

// The file whose describe callback is running. A registration in a concise
// arrow (`() => test(...)`) is a tail call, and JavaScriptCore drops the
// caller's frame, so the stack can hold no test-file frame at all.
let describeFile: string | null = null;

function registrationLocation(): RegistrationLocation {
	const found = sourceLocation();
	if (found !== null) return found;
	if (describeFile !== null) {
		return { file: describeFile, text: `${describeFile} (line not in the stack: a tail call)` };
	}
	return { file: null, text: "an unknown place (no test-file frame in the stack)" };
}

function sourceLocation(): RegistrationLocation | null {
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
		return { file: pathFromRoot, text: `${pathFromRoot}:${match[2]}` };
	}
	return null;
}

type RegistrationKind = "test" | "describe";
type RegistrationMode = "normal" | "each-selector" | "each-registration";
type Callable = (...args: unknown[]) => unknown;

function wrapCallback(
	callback: Callable,
	fullName: string | ((args: unknown[]) => string),
	location: string,
): Callable {
	const wrapped: Callable = function (this: unknown, ...args: unknown[]): unknown {
		entered = true;
		currentTestName = typeof fullName === "string" ? fullName : fullName(args);
		currentTestLocation = location;
		writeSlot(`running: ${currentTestName}\n  registered at ${location}`);

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

function eachName(template: string, rowArgs: unknown[]): string {
	if (template.includes("%")) return format(template, ...rowArgs);
	const row = rowArgs[0];
	if (
		typeof row !== "object" ||
		row === null ||
		Array.isArray(row) ||
		!/\$[A-Za-z_$][\w$]*/.test(template)
	) {
		return template;
	}
	return template.replace(/\$([A-Za-z_$][\w$]*)/g, (_match, key: string) =>
		String(Reflect.get(row, key)),
	);
}

function wrapRegistration(
	kind: RegistrationKind,
	original: Callable,
	boundThis?: unknown,
	mode: RegistrationMode = "normal",
): Callable {
	return new Proxy(original, {
		apply(target, thisArg: unknown, args: unknown[]): unknown {
			const receiver = boundThis ?? thisArg;
			if (mode === "each-selector") {
				const result: unknown = Reflect.apply(target, receiver, args);
				return typeof result === "function"
					? wrapRegistration(kind, result as Callable, result, "each-registration")
					: result;
			}
			const name = args[0];
			const callback = args[1];
			if (typeof name !== "string" || typeof callback !== "function") {
				const result: unknown = Reflect.apply(target, receiver, args);
				return typeof result === "function"
					? wrapRegistration(kind, result as Callable, result)
					: result;
			}

			const { file, text: location } = registrationLocation();
			const namePrefix = [...describeNames];
			const fullName = [...namePrefix, name].join(" > ");
			writeSlot(`running: no test yet, loading ${file ?? "an unknown file"}`);

			if (kind === "describe") {
				const wrappedDescribe: Callable = function (
					this: unknown,
					...describeArgs: unknown[]
				): unknown {
					const previousNames = [...describeNames];
					const previousFile = describeFile;
					describeFile = file ?? previousFile;
					const describeName =
						mode === "each-registration" ? eachName(name, describeArgs) : name;
					describeNames.splice(0, describeNames.length, ...namePrefix, describeName);
					try {
						return Reflect.apply(callback as Callable, this, describeArgs);
					} finally {
						describeNames.splice(0, describeNames.length, ...previousNames);
						describeFile = previousFile;
					}
				};
				Object.defineProperty(wrappedDescribe, "length", { value: callback.length });
				const wrappedArgs = [...args];
				wrappedArgs[1] = wrappedDescribe;
				return Reflect.apply(target, receiver, wrappedArgs);
			}

			const wrappedArgs = [...args];
			const nameForRun =
				mode === "each-registration"
					? (rowArgs: unknown[]) =>
							[...namePrefix, eachName(name, rowArgs)].join(" > ")
					: fullName;
			wrappedArgs[1] = wrapCallback(callback as Callable, nameForRun, location);
			const result: unknown = Reflect.apply(target, receiver, wrappedArgs);
			return typeof result === "function"
				? wrapRegistration(kind, result as Callable, result)
				: result;
		},
		get(target, property: string | symbol): unknown {
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function"
				? wrapRegistration(
						kind,
						value as Callable,
						target,
						property === "each" ? "each-selector" : "normal",
					)
				: value;
		},
	});
}

function wrapHookCallback(callback: Callable, hookName: string, location: string): Callable {
	const wrapped: Callable = function (this: unknown, ...args: unknown[]): unknown {
		const previousSlotText = slotText;
		const lastTest = currentTestName === "" ? "" : `\n  last test: ${JSON.stringify(currentTestName)}`;
		writeSlot(`running: ${hookName} hook registered at ${location}${lastTest}`);
		let restored = false;
		const restore = (): void => {
			if (restored) return;
			restored = true;
			writeSlot(previousSlotText);
		};

		const wrappedArgs = [...args];
		const usesDone = callback.length > 0 && typeof wrappedArgs[0] === "function";
		if (usesDone) {
			const done = wrappedArgs[0] as Callable;
			wrappedArgs[0] = function (this: unknown, ...doneArgs: unknown[]): unknown {
				try {
					return Reflect.apply(done, this, doneArgs);
				} finally {
					restore();
				}
			};
		}

		let waitForCompletion = usesDone;
		try {
			const result: unknown = Reflect.apply(callback, this, wrappedArgs);
			if (isThenable(result)) {
				waitForCompletion = true;
				void Promise.resolve(result).then(restore, restore);
			}
			return result;
		} finally {
			if (!waitForCompletion) restore();
		}
	};
	Object.defineProperty(wrapped, "length", { value: callback.length });
	return wrapped;
}

function wrapHookRegistration(hookName: string, original: Callable): Callable {
	const wrapped: Callable = function (this: unknown, ...args: unknown[]): unknown {
		const callback = args[0];
		if (typeof callback !== "function") return Reflect.apply(original, this, args);
		const wrappedArgs = [...args];
		wrappedArgs[0] = wrapHookCallback(callback as Callable, hookName, registrationLocation().text);
		return Reflect.apply(original, this, wrappedArgs);
	};
	Object.defineProperty(wrapped, "length", { value: original.length });
	return wrapped;
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
	beforeEach: Callable;
	afterEach: Callable;
	beforeAll: Callable;
	afterAll: Callable;
};
const nativeBeforeEach = bunTest.beforeEach;
const nativeAfterEach = bunTest.afterEach;

bunTest.test = wrapRegistration("test", bunTest.test);
bunTest.it = wrapRegistration("test", bunTest.it);
bunTest.describe = wrapRegistration("describe", bunTest.describe);
bunTest.beforeEach = wrapHookRegistration("beforeEach", nativeBeforeEach);
bunTest.afterEach = wrapHookRegistration("afterEach", nativeAfterEach);
bunTest.beforeAll = wrapHookRegistration("beforeAll", bunTest.beforeAll);
bunTest.afterAll = wrapHookRegistration("afterAll", bunTest.afterAll);

nativeBeforeEach(() => {
	entered = false;
});
nativeAfterEach(() => {
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
