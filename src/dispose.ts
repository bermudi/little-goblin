// Function-scoped resource owners for `await using` (#447). Module-lifetime
// owners keep their stop()/close().

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function tempDir(
	prefix: string,
): Promise<AsyncDisposable & { readonly path: string }> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	return {
		path,
		async [Symbol.asyncDispose](): Promise<void> {
			await rm(path, { recursive: true, force: true });
		},
	};
}

export function ownedReader<T>(
	stream: ReadableStream<T>,
): AsyncDisposable & { readonly reader: ReadableStreamDefaultReader<T> } {
	// TS2741: node:stream/web's reader omits the DOM type's required readMany.
	const reader = stream.getReader() as unknown as ReadableStreamDefaultReader<T>;
	let errored = false;
	void reader.closed.then(
		() => {},
		() => {
			errored = true;
		},
	);
	return {
		reader,
		async [Symbol.asyncDispose](): Promise<void> {
			// An errored stream is already torn down; cancel would rethrow its read error.
			if (errored) {
				reader.releaseLock();
				return;
			}
			try {
				await reader.cancel();
			} finally {
				reader.releaseLock();
			}
		},
	};
}
