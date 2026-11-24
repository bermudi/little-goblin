import type { MessageChunk } from "../message.ts";
import { appMediaSink, composeTurnSinks, type AppMediaDeps } from "../app-media.ts";
import { log } from "../log.ts";
import { every, type Timer } from "../timing.ts";
import type { TurnDone, TurnSink } from "../turn/sink.ts";
import { NO_STORE } from "./app-shared.ts";

const SSE_HEARTBEAT_MS = 5_000;

export function eventStream<E>(
	req: Request,
	opts: {
		keepaliveMs: number;
		label: string;
		open(push: (event: E) => void): () => void;
		onClose(): void;
	},
): Response {
	const encoder = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	let cancelled = false;
	let unsubscribe = () => {};
	let keepalive: Timer | undefined;
	const send = (frame: string) => {
		if (closed) return;
		try {
			controller.enqueue(encoder.encode(`${frame}\n\n`));
		} catch {
			close();
		}
	};
	const close = () => {
		if (closed) return;
		closed = true;
		keepalive?.cancel();
		unsubscribe();
		req.signal.removeEventListener("abort", onAbort);
		if (!cancelled) controller.close();
		opts.onClose();
	};
	const onAbort = () => close();
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			unsubscribe = opts.open((event) => send(`data: ${JSON.stringify(event)}`));
			if (closed) {
				unsubscribe();
				return;
			}
			keepalive = every(opts.keepaliveMs, `${opts.label} keepalive`, () => send(": keepalive"), {
				unref: true,
			});
			req.signal.addEventListener("abort", onAbort, { once: true });
			if (req.signal.aborted) close();
		},
		cancel() {
			cancelled = true;
			close();
		},
	});
	return new Response(body, {
		headers: { ...NO_STORE, "content-type": "text/event-stream; charset=utf-8" },
	});
}

export function appSseWriter(
	convId: string,
	heartbeatMs: number = SSE_HEARTBEAT_MS,
	onCancel?: () => void,
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
	let errorWritten = false;
	let finishWritten = false;
	let lastByte = Date.now();
	let beat: Timer | undefined;
	const stopBeat = () => {
		beat?.cancel();
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
				beat = every(
					Math.max(200, Math.floor(heartbeatMs / 4)),
					"app stream heartbeat",
					() => {
						if (!closed && Date.now() - lastByte >= heartbeatMs) push(": ping\n\n");
					},
					{ unref: true },
				);
			}
		},
		cancel() {
			closed = true;
			wireDied = true;
			stopBeat();
			onCancel?.();
			log.warn("app stream client gone — wire closed, turn continues", {
				conversation: convId,
			});
		},
	});
	return {
		body,
		write(chunk) {
			if (chunk.type === "error") errorWritten = true;
			if (chunk.type === "finish") finishWritten = true;
			push(`data: ${JSON.stringify(chunk)}\n\n`);
		},
		finish(done) {
			stopBeat();
			if (done.kind !== "completed") {
				if (!errorWritten) {
					push(`data: ${JSON.stringify({
						type: "error",
						errorText:
							done.kind === "error"
								? done.message
								: done.shutdown
									? 'turn stopped: goblin restarted (deploy or service restart). Send a new message to continue.'
									: "turn stopped before finishing",
					})}\n\n`);
				}
				if (done.kind === "error" && !finishWritten) {
					push(`data: ${JSON.stringify({ type: "finish", finishReason: "error" })}\n\n`);
				}
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

export function appConversationSink(
	convId: string,
	media?: AppMediaDeps,
	onDone?: (done: TurnDone) => Promise<void>,
): TurnSink {
	const stream: TurnSink = {
		delivery: "stream",
		onTextDelta() {},
		onReasoningDelta() {},
		onToolCall() {},
		onStreamChunk() {},
		async onDone(done) {
			log.info("app conversation turn finish", { conversation: convId, outcome: done.kind });
			await onDone?.(done);
		},
	};
	return media === undefined
		? stream
		: composeTurnSinks(stream, appMediaSink(convId, media, () => {}));
}
