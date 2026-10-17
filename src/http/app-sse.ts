// The app channel's SSE wire — one shape shared by the submit stream
// (appStreamSink: chunks from the turn's member sink) and the attach
// stream (GET .../stream: chunks from a live-turn subscription).
//
// Bun.serve closes connections that send no bytes for its idleTimeout
// — 10s by default. Tool calls silence the UIMessage stream for tens
// of seconds, so the wire needs a heartbeat: SSE comment lines, which
// spec parsers and eventsource-
// parser (the AI SDK client's) skip without emitting. Ruling recorded in
// design/app.md.

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
			// Bun closes the controller when the wire dies (idle kill or
			// client vanish). The turn keeps writing durable history — but
			// the boundary owes the log a line so a lost reply is observable.
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
			// Beats only while the wire is silent — real chunks reset the clock.
			// The tick samples 4x per heartbeat window: a tick period equal to
			// the threshold phase-locks with real chunks landing just before
			// each tick and never fires.
			if (heartbeatMs > 0) {
				beat = setInterval(
					() => {
						if (!closed && Date.now() - lastByte >= heartbeatMs) push(": ping\n\n");
					},
					Math.max(200, Math.floor(heartbeatMs / 4)),
				);
				// A leaked beat must never hold the process (or a test run) open.
				(beat as unknown as { unref?: () => void }).unref?.();
			}
		},
		// Client disconnected mid-turn — the turn keeps writing durable
		// history; only the wire closes, and the loss must be observable.
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
			// A turn that ended without a finish chunk (fenced by /stop,
			// or crashed) still owes the client a terminal event.
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
				/* already closed */
			}
		},
		// Orphan paths (204 attach, submit-threw 500s): the writer was
		// constructed — the heartbeat is armed — but no wire will ever
		// consume the body. Stop the beat and close quietly: no frames, no
		// finish line: a leaked beat would enqueue into an unread stream
		// forever.
		dispose() {
			stopBeat();
			closed = true;
			try {
				controller.close();
			} catch {
				/* already closed */
			}
		},
	};
}

export function appStreamSink(convId: string): {
	sink: TurnSink;
	body: ReadableStream<Uint8Array>;
	// Orphan-path cleanup (review M1): a submit that throws after this
	// sink was built leaves the writer's heartbeat armed with no wire.
	dispose(): void;
} {
	const writer = appSseWriter(convId);
	return {
		body: writer.body,
		dispose: writer.dispose,
		sink: {
			// Delta-style delivery hooks are telegram's — the app stream is
			// the raw chunk pass-through alone.
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
