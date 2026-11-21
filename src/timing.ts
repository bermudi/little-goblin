import { log } from "./log.ts";

export interface Timer {
	cancel(): void;
}

export interface TimerOptions {
	unref?: boolean;
}

export function after(
	ms: number,
	label: string,
	fn: () => unknown,
	options: TimerOptions = {},
): Timer {
	const handle = setTimeout(() => {
		try {
			const result = fn();
			if (result instanceof Promise) {
				result.catch((err: unknown) => log.error("timer callback failed", err, { timer: label }));
			}
		} catch (err) {
			log.error("timer callback failed", err, { timer: label });
		}
	}, ms);
	if (options.unref === true) handle.unref();
	return { cancel: () => clearTimeout(handle) };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted === true) return Promise.resolve();
	return new Promise((resolve) => {
		const handle = setTimeout(finish, ms);
		function finish(): void {
			clearTimeout(handle);
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
	const handle = setTimeout(() => {
		expired = true;
		controller.abort();
	}, ms);
	if (options.unref === true) handle.unref();
	parent?.addEventListener("abort", abort, { once: true });
	if (parent?.aborted === true) abort();
	return {
		signal: controller.signal,
		expired: () => expired,
		[Symbol.dispose]() {
			clearTimeout(handle);
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
	let handle: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const stop = new Promise<Within<T>>((resolve) => {
		handle = setTimeout(() => resolve({ kind: "timeout" }), ms);
		onAbort = () => resolve({ kind: "aborted" });
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([work.then((value): Within<T> => ({ kind: "settled", value })), stop]);
	} finally {
		clearTimeout(handle);
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
	}
}
