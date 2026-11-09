// The shared backoff sleep for goblin-granted model-call retries — the
// pre-stream transport middleware (agent/providers.ts) and the
// callback-directed step retry (turn/stream.ts) both wait on it, so a
// stopped call never holds its lane for the full backoff.

// The SDK retry ladder's initialDelayInMs default — one delay story for
// every retry goblin grants.
export const RETRY_INITIAL_DELAY_MS = 2000;

export function awaitRetryDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (ms <= 0 || signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(finish, ms);
		function finish(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		}
		signal?.addEventListener("abort", finish, { once: true });
	});
}
