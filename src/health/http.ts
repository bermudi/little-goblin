import { ProbeError } from "./shared.ts";

export async function http(
	url: string,
	timeoutMs: number,
	signal?: AbortSignal,
	body?: string,
): Promise<{ status: number; text: string }> {
	if (signal?.aborted) throw new ProbeError("cancelled");
	const controller = new AbortController();
	let expired = false;
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => {
		expired = true;
		abort();
	}, timeoutMs);
	let reader:
		| {
				read(): Promise<{ done?: boolean; value?: Uint8Array }>;
				cancel(): Promise<void>;
				releaseLock(): void;
		  }
		| undefined;
	try {
		const response = await fetch(url, {
			method: body ? "POST" : "GET",
			...(body ? { body, headers: { "Content-Type": "application/json" } } : {}),
			signal: controller.signal,
			redirect: "error",
		});
		const chunks: Uint8Array[] = [];
		let size = 0;
		reader = response.body?.getReader();
		if (reader)
			for (;;) {
				const item = await reader.read();
				if (item.done) break;
				if (!item.value) throw new ProbeError("invalid-HTTP-stream");
				size += item.value.byteLength;
				if (size > 64 * 1024) {
					controller.abort();
					throw new ProbeError("oversized-HTTP-body");
				}
				chunks.push(item.value);
			}
		return { status: response.status, text: Buffer.concat(chunks).toString("utf8") };
	} catch (error) {
		throw new ProbeError(
			signal?.aborted
				? "cancelled"
				: expired
					? "deadline"
					: error instanceof ProbeError
						? error.category
						: "HTTP-transport-or-body-error",
		);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		controller.abort();
		if (reader) {
			void reader.cancel().catch(() => {
				/* Aborted body is already closed. */
			});
			reader.releaseLock();
		}
	}
}
