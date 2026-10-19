import type { UIMessageChunk } from "ai";
import { log } from "../log.ts";
import type { TurnDone, TurnSink } from "../runtime.ts";

const SSE_HEARTBEAT_MS = 5_000;

export function appSseWriter(
	convId: string,
	heartbeatMs: number = SSE_HEARTBEAT_MS,
): {
	body: ReadableStream<Uint8Array>;
	write(chunk: UIMessageChunk): void;
	finish(done: TurnDone): void;
	dispose(): void;
} {
	const enc = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	let lastByte = Date.now();
	let beat: ReturnType<typeof setInterval> | undefined;
	const stopBeat = () => {
		if (beat !== undefined) clearInterval(beat);
		beat = undefined;
	};
	const push = (line: string) => {
		if (closed) return;
		try {
			controller.enqueue(enc.encode(line));
			lastByte = Date.now();
		} catch (err) {
			closed = true;
			stopBeat();
			log.warn("app stream wire died mid-turn — writes dropped, turn continues", err, {
				conversation: convId,
			});
		}
	};
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			if (heartbeatMs > 0) {
				beat = setInterval(
					() => {
						if (!closed && Date.now() - lastByte >= heartbeatMs) push(": ping\n\n");
					},
					Math.max(200, Math.floor(heartbeatMs / 4)),
				);
				(beat as unknown as { unref?: () => void }).unref?.();
			}
		},
		cancel() {
			closed = true;
			stopBeat();
			log.warn("app stream client gone — wire closed, turn continues", {
				conversation: convId,
			});
		},
	});
	return {
		body,
		write(chunk) {
			push(`data: ${JSON.stringify(chunk)}\n\n`);
		},
		finish(done) {
			stopBeat();
			if (done.kind !== "completed") {
				push(
					`data: ${JSON.stringify({
						type: "error",
						errorText: done.kind === "error" ? done.message : "turn stopped before finishing",
					})}\n\n`,
				);
			}
			push("data: [DONE]\n\n");
			closed = true;
			try {
				controller.close();
			} catch {
			}
		},
		dispose() {
			stopBeat();
			closed = true;
			try {
				controller.close();
			} catch {
			}
		},
	};
}

export function appStreamSink(convId: string): {
	sink: TurnSink;
	body: ReadableStream<Uint8Array>;
	dispose(): void;
} {
	const writer = appSseWriter(convId);
	return {
		body: writer.body,
		dispose: writer.dispose,
		sink: {
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onStreamChunk(chunk) {
				writer.write(chunk);
			},
			onDone(done) {
				writer.finish(done);
				log.info("app stream finish", { conversation: convId, outcome: done.kind });
			},
		},
	};
}
