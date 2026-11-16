import type { MessageChunk } from "../message.ts";
import { appMediaSink, composeTurnSinks, type AppMediaDeps } from "../app-media.ts";
import { log } from "../log.ts";
import type { TurnDone, TurnSink } from "../turn/sink.ts";

const SSE_HEARTBEAT_MS = 5_000;

export function appSseWriter(
	convId: string,
	heartbeatMs: number = SSE_HEARTBEAT_MS,
): {
	body: ReadableStream<Uint8Array>;
	write(chunk: MessageChunk): void;
	finish(done: TurnDone): void;
	wireDied(): boolean;
	dispose(): void;
} {
	const enc = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	let wireDied = false;
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
			wireDied = true;
			stopBeat();
			log.warn("app stream wire died mid-turn — writes dropped, turn continues", err, {
				conversation: convId,
			});
		}
	};
	// `closed` is already true when the client cancelled or an enqueue
	// failed; the controller is then closed or errored and close() throws.
	const close = () => {
		if (closed) return;
		closed = true;
		controller.close();
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
			wireDied = true;
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
						errorText:
							done.kind === "error"
								? done.message
								: done.shutdown
									? 'turn stopped: goblin restarted (deploy or service restart). Send "continue" to resume.'
									: "turn stopped before finishing",
					})}\n\n`,
				);
			}
			push("data: [DONE]\n\n");
			close();
		},
		wireDied() {
			return wireDied;
		},
		dispose() {
			stopBeat();
			close();
		},
	};
}

export function appStreamSink(
	convId: string,
	media?: AppMediaDeps,
	onDoneDisconnected?: (done: TurnDone) => Promise<void>,
): {
	sink: TurnSink;
	body: ReadableStream<Uint8Array>;
	dispose(): void;
} {
	const writer = appSseWriter(convId);
	const stream: TurnSink = {
		onTextDelta() {},
		onReasoningDelta() {},
		onToolCall() {},
		onStreamChunk(chunk) {
			writer.write(chunk);
		},
		async onDone(done) {
			const disconnectedBefore = writer.wireDied();
			writer.finish(done);
			const disconnected = disconnectedBefore || writer.wireDied();
			log.info("app stream finish", { conversation: convId, outcome: done.kind });
			if (disconnected) await onDoneDisconnected?.(done);
		},
	};
	return {
		body: writer.body,
		dispose: writer.dispose,
		sink:
			media === undefined
				? stream
				: composeTurnSinks(
						stream,
						appMediaSink(convId, media, (chunk) => writer.write(chunk)),
					),
	};
}
