import { log } from "./log.ts";

export interface Timer {
	cancel(): void;
}

export interface TimerOptions {
	unref?: boolean;
}

const MAX_TIMER_MS = 2 ** 31 - 1;

function arm(ms: number, fn: () => void, unref: boolean): () => void {
	let left = ms;
	let handle: ReturnType<typeof setTimeout>;
	const step = (): void => {
		const chunk = Math.min(left, MAX_TIMER_MS);
		left -= chunk;
		handle = setTimeout(left > 0 ? step : fn, chunk);
		if (unref) handle.unref();
	};
	step();
	return () => {
		clearTimeout(handle);
	};
}

function run(label: string, fn: () => unknown): void {
	try {
		const result = fn();
		if (result instanceof Promise) {
			result.catch((err: unknown) => log.error("timer callback failed", err, { timer: label }));
		}
	} catch (err) {
		log.error("timer callback failed", err, { timer: label });
	}
}

export function after(
	ms: number,
	label: string,
	fn: () => unknown,
	options: TimerOptions = {},
): Timer {
	const cancel = arm(ms, () => run(label, fn), options.unref === true);
	return { cancel };
}

export function every(
	ms: number,
	label: string,
	fn: () => unknown,
	options: TimerOptions & { immediate?: boolean } = {},
): Timer {
	if (!(ms > MAX_TIMER_MS)) {
		const handle = setInterval(() => run(label, fn), ms);
		if (options.unref === true) handle.unref();
		if (options.immediate === true) run(label, fn);
		return { cancel: () => clearInterval(handle) };
	}
	const step = (): void => {
		cancelArm = arm(ms, step, options.unref === true);
		run(label, fn);
	};
	let cancelArm = arm(ms, step, options.unref === true);
	if (options.immediate === true) run(label, fn);
	return { cancel: () => cancelArm() };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted === true) return Promise.resolve();
	return new Promise((resolve) => {
		const cancel = arm(ms, finish, false);
		function finish(): void {
			cancel();
			signal?.removeEventListener("abort", finish);
			resolve();
		}
		signal?.addEventListener("abort", finish, { once: true });
	});
}

export interface Deadline extends Disposable {
	readonly signal: AbortSignal;
	expired(): boolean;
}

export function deadline(ms: number, parent?: AbortSignal, options: TimerOptions = {}): Deadline {
	const controller = new AbortController();
	let expired = false;
	const abort = (): void => controller.abort(parent?.reason);
	const cancel = arm(ms, () => {
		expired = true;
		controller.abort();
	}, options.unref === true);
	parent?.addEventListener("abort", abort, { once: true });
	if (parent?.aborted === true) abort();
	return {
		signal: controller.signal,
		expired: () => expired,
		[Symbol.dispose]() {
			cancel();
			parent?.removeEventListener("abort", abort);
		},
	};
}

export type Within<T> =
	| { kind: "settled"; value: T }
	| { kind: "timeout" }
	| { kind: "aborted" };

export async function within<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<Within<T>> {
	if (signal?.aborted === true) return { kind: "aborted" };
	let cancel: (() => void) | undefined;
	let onAbort: (() => void) | undefined;
	const stop = new Promise<Within<T>>((resolve) => {
		cancel = arm(ms, () => resolve({ kind: "timeout" }), false);
		onAbort = () => resolve({ kind: "aborted" });
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([work.then((value): Within<T> => ({ kind: "settled", value })), stop]);
	} finally {
		cancel?.();
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
	}
}
